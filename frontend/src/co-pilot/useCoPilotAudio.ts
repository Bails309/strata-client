/**
 * WebRTC full-mesh audio for a co-pilot room.
 *
 * Topology: every participant opens a direct `RTCPeerConnection` to
 * every other participant. With `MAX_PARTICIPANTS = 6` server-side
 * that's at most 5 PCs per peer — comfortably inside browser limits
 * and avoids the latency hit of routing audio through a server.
 *
 * Signalling rides on top of the existing co-pilot WS via three
 * envelope types (`audio_offer` / `audio_answer` / `ice`) which the
 * server relays verbatim between named pids. The hook installs an
 * envelope handler (via `setAudioHandler`) so `useCoPilotRoom` can
 * dispatch incoming WebRTC frames here without coupling.
 *
 * Race / ordering notes:
 * - To prevent two peers offering each other simultaneously
 *   ("glare"), we use a deterministic tie-break: the participant
 *   with the **lower** lexicographic pid is the offerer.
 * - ICE candidates can arrive before the remote description has been
 *   set (the spec allows this). We buffer them per-pid and flush on
 *   `setRemoteDescription`.
 * - When a peer leaves the roster, we tear down the corresponding PC
 *   and remove its `<audio>` element from the document.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RosterEntry } from "./protocol";

/** Envelope subtypes this hook handles. */
export type AudioSignalEnvelope =
  | { type: "audio_offer"; pid: string; to: string; sdp: string }
  | { type: "audio_answer"; pid: string; to: string; sdp: string }
  | { type: "ice"; pid: string; to: string; candidate: string };

export interface CoPilotAudioOptions {
  /** Live roster from `useCoPilotRoom`. */
  roster: RosterEntry[];
  /** Local participant pid; `null` until the WS welcome arrives. */
  selfPid: string | null;
  /** Server-side `allow_audio` flag. */
  allowAudio: boolean;
  /** `true` once the user has opted in via the "Join audio" toggle. */
  joined: boolean;
  /** Sends a signalling envelope upstream over the co-pilot WS. */
  sendAudio: (msg: AudioSignalEnvelope) => void;
  /** Registers a one-shot handler for inbound audio envelopes. */
  setAudioHandler: (handler: ((msg: AudioSignalEnvelope) => void) | null) => void;
}

export interface CoPilotAudioState {
  /** `true` while the browser is acquiring the microphone. */
  acquiring: boolean;
  /** Set to a user-facing error string when `getUserMedia` fails. */
  error: string | null;
  /** Pids of peers we currently have an active audio PC to. */
  connectedPeers: string[];
}

/** Standard public STUN — sufficient for browser-to-browser on the same LAN
 *  segment or via direct public IPs. TURN is intentionally out of scope here;
 *  if the deployment crosses NATs that need it, surface a `[TURN]` config
 *  channel and inject `iceServers` from the server roster envelope. */
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/**
 * Manages the local mic + a `Map<pid, RTCPeerConnection>` while the
 * caller is opted into audio. No-ops while `joined` is false.
 */
export function useCoPilotAudio(opts: CoPilotAudioOptions): CoPilotAudioState {
  const { roster, selfPid, allowAudio, joined, sendAudio, setAudioHandler } = opts;

  const [acquiring, setAcquiring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);

  // All mutable WebRTC state lives in refs so React state updates
  // never tear down or recreate the connection map mid-negotiation.
  const localStreamRef = useRef<MediaStream | null>(null);
  const pcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Inbound ICE candidates received before the remote description has
  // been applied. Flushed in `setRemoteDescription`.
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Hidden <audio> elements appended to <body> for each remote stream.
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  const refreshConnectedPeers = useCallback(() => {
    setConnectedPeers(Array.from(pcMapRef.current.keys()));
  }, []);

  /** Wire a single new RTCPeerConnection for `peerPid`. */
  const createPc = useCallback(
    (peerPid: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection(ICE_SERVERS);

      // Local tracks (mic). `addTrack` is safe even if there are zero
      // tracks; the recv-only side just won't get any audio frames.
      const local = localStreamRef.current;
      if (local) {
        for (const track of local.getAudioTracks()) {
          pc.addTrack(track, local);
        }
      }

      pc.onicecandidate = (e) => {
        if (!e.candidate || !selfPid) return;
        sendAudio({
          type: "ice",
          pid: selfPid,
          to: peerPid,
          candidate: JSON.stringify(e.candidate.toJSON()),
        });
      };

      pc.ontrack = (e) => {
        const [stream] = e.streams;
        if (!stream) return;
        // Reuse an existing element if we already have one for this
        // peer (re-negotiation case); otherwise mount a fresh one.
        let el = audioElsRef.current.get(peerPid);
        if (!el) {
          el = document.createElement("audio");
          el.autoplay = true;
          el.dataset.coPilotPeer = peerPid;
          el.style.display = "none";
          document.body.appendChild(el);
          audioElsRef.current.set(peerPid, el);
        }
        el.srcObject = stream;
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected" ||
          pc.connectionState === "closed"
        ) {
          // We let the roster-diff effect handle cleanup so a brief
          // ICE disconnect doesn't tear the session down — but if the
          // peer is already gone from the roster we want to free
          // resources eagerly.
        }
      };

      pcMapRef.current.set(peerPid, pc);
      refreshConnectedPeers();
      return pc;
    },
    [selfPid, sendAudio, refreshConnectedPeers]
  );

  const teardownPc = useCallback(
    (peerPid: string) => {
      const pc = pcMapRef.current.get(peerPid);
      if (pc) {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
        pcMapRef.current.delete(peerPid);
      }
      pendingIceRef.current.delete(peerPid);
      const el = audioElsRef.current.get(peerPid);
      if (el) {
        el.srcObject = null;
        try {
          el.remove();
        } catch {
          /* ignore */
        }
        audioElsRef.current.delete(peerPid);
      }
      refreshConnectedPeers();
    },
    [refreshConnectedPeers]
  );

  /** Drain buffered ICE candidates after the remote description lands. */
  const flushPendingIce = useCallback(async (peerPid: string, pc: RTCPeerConnection) => {
    const pending = pendingIceRef.current.get(peerPid);
    if (!pending || pending.length === 0) return;
    pendingIceRef.current.delete(peerPid);
    for (const init of pending) {
      try {
        await pc.addIceCandidate(init);
      } catch {
        /* a single bad candidate shouldn't kill the negotiation */
      }
    }
  }, []);

  // ── Inbound signalling ────────────────────────────────────────────
  useEffect(() => {
    if (!joined || !allowAudio || !selfPid) {
      setAudioHandler(null);
      return;
    }
    const handler = async (msg: AudioSignalEnvelope) => {
      if (msg.to !== selfPid) return;
      if (msg.type === "audio_offer") {
        let pc = pcMapRef.current.get(msg.pid);
        if (!pc) pc = createPc(msg.pid);
        try {
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          await flushPendingIce(msg.pid, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendAudio({
            type: "audio_answer",
            pid: selfPid,
            to: msg.pid,
            sdp: answer.sdp ?? "",
          });
        } catch (e) {
          // Negotiation aborted — leave the PC up so a fresh offer can
          // re-establish on the next roster tick if the peer retries.
          console.warn("[co-pilot audio] answer negotiation failed", e);
        }
      } else if (msg.type === "audio_answer") {
        const pc = pcMapRef.current.get(msg.pid);
        if (!pc) return;
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          await flushPendingIce(msg.pid, pc);
        } catch (e) {
          console.warn("[co-pilot audio] applying answer failed", e);
        }
      } else if (msg.type === "ice") {
        let init: RTCIceCandidateInit;
        try {
          init = JSON.parse(msg.candidate);
        } catch {
          return;
        }
        const pc = pcMapRef.current.get(msg.pid);
        if (!pc || !pc.remoteDescription) {
          const buf = pendingIceRef.current.get(msg.pid) ?? [];
          buf.push(init);
          pendingIceRef.current.set(msg.pid, buf);
          return;
        }
        try {
          await pc.addIceCandidate(init);
        } catch {
          /* ignore stray candidate */
        }
      }
    };
    setAudioHandler(handler);
    return () => setAudioHandler(null);
  }, [joined, allowAudio, selfPid, sendAudio, setAudioHandler, createPc, flushPendingIce]);

  // ── Mic acquisition (active while joined) ─────────────────────────
  useEffect(() => {
    if (!joined || !allowAudio) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcquiring(true);
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        setAcquiring(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message || "Microphone unavailable");
        setAcquiring(false);
      });
    return () => {
      cancelled = true;
      const stream = localStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    };
  }, [joined, allowAudio]);

  // ── Roster-driven mesh maintenance ────────────────────────────────
  useEffect(() => {
    if (!joined || !allowAudio || !selfPid || !localStreamRef.current) return;

    const rosterPids = new Set(roster.map((r) => r.pid));

    // 1. Tear down PCs for peers that have left the room.
    for (const pid of Array.from(pcMapRef.current.keys())) {
      if (!rosterPids.has(pid)) teardownPc(pid);
    }

    // 2. Open PCs to new peers. Lower lexicographic pid initiates so
    //    we don't get glare from both sides offering simultaneously.
    for (const peer of roster) {
      if (peer.pid === selfPid) continue;
      if (pcMapRef.current.has(peer.pid)) continue;
      const pc = createPc(peer.pid);
      if (selfPid < peer.pid) {
        // We're the offerer.
        (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendAudio({
              type: "audio_offer",
              pid: selfPid,
              to: peer.pid,
              sdp: offer.sdp ?? "",
            });
          } catch (e) {
            console.warn("[co-pilot audio] offer failed", e);
            teardownPc(peer.pid);
          }
        })();
      }
      // Higher pid waits for the inbound offer; nothing to do here.
    }
    // Re-running purely on roster changes is intentional; localStream
    // changes are gated by the joined-effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, joined, allowAudio, selfPid, acquiring]);

  // ── Full cleanup on unmount ────────────────────────────
  useEffect(() => {
    // Snapshot the ref so the cleanup closure doesn't read a mutated
    // value after a remount; React's exhaustive-deps lint requires it.
    const pcMap = pcMapRef.current;
    const audioEls = audioElsRef.current;
    return () => {
      for (const pid of Array.from(pcMap.keys())) {
        teardownPc(pid);
      }
      // Defensive: also drop any stray <audio> elements the teardown
      // loop missed (shouldn't happen, but cheap insurance).
      for (const el of audioEls.values()) {
        try {
          el.remove();
        } catch {
          /* ignore */
        }
      }
      const stream = localStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    };
  }, [teardownPc]);

  return { acquiring, error, connectedPeers };
}
