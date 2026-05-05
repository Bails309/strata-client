import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import Guacamole from "guacamole-common-js";
import { buildNvrObserveUrl, buildUserNvrObserveUrl, ensureFreshToken } from "../api";

type Phase = "connecting" | "replaying" | "live" | "ended" | "error";

/* ── Timeline constants ──────────────────────────────────────────── */
const MAX_BUFFER_SECS = 300; // 5 minutes
const REWIND_MARKERS = [30, 60, 180, 300]; // seconds from live edge

export default function NvrPlayer() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const tunnelRef = useRef<Guacamole.Tunnel | null>(null);

  const useAdminEndpoint = searchParams.get("admin") === "1";

  const [phase, setPhase] = useState<Phase>("connecting");
  const [offset, setOffset] = useState(() => {
    const o = searchParams.get("offset");
    return o ? parseInt(o, 10) : 300;
  });
  const [speed, setSpeed] = useState(1);
  const [errorMsg, setErrorMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  // Replay progress state
  const [replayTotalMs, setReplayTotalMs] = useState(0);
  const [replayProgressMs, setReplayProgressMs] = useState(0);
  const replayTotalMsRef = useRef(0);
  const replayProgressMsRef = useRef(0);

  // Pause state — freezes the display while the stream continues
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  // Timeline state — buffer depth and offset reported by the backend
  const [bufferDepthMs, setBufferDepthMs] = useState(MAX_BUFFER_SECS * 1000);
  const [timelineOffsetSecs, setTimelineOffsetSecs] = useState(300);

  const connectionName = searchParams.get("name") || "Session";
  const username = searchParams.get("user") || "";

  // Cleanup helper
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (tunnelRef.current) {
      tunnelRef.current.oninstruction = null;
      tunnelRef.current = null;
    }
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
  }, []);

  // Connect / reconnect
  const connect = useCallback(
    async (rewindSecs: number, playbackSpeed: number) => {
      if (!sessionId || !containerRef.current) return;
      cleanup();

      const container = containerRef.current;
      container.innerHTML = "";

      setPhase("connecting");
      setErrorMsg("");
      setOffset(rewindSecs);
      setSpeed(playbackSpeed);
      setPaused(false);
      pausedRef.current = false;
      setReplayTotalMs(0);
      setReplayProgressMs(0);
      elapsedRef.current = 0;
      setElapsed(0);

      // Ensure the access token is fresh before opening the WebSocket
      // (WS connections cannot use the normal 401-retry interceptor).
      const token = await ensureFreshToken();
      if (!token) {
        setPhase("error");
        setErrorMsg("Session expired — please log in again.");
        return;
      }

      const fullUrl = await (useAdminEndpoint ? buildNvrObserveUrl : buildUserNvrObserveUrl)(
        sessionId,
        rewindSecs,
        playbackSpeed
      );
      const qIdx = fullUrl.indexOf("?");
      const tunnelBase = qIdx >= 0 ? fullUrl.substring(0, qIdx) : fullUrl;
      const tunnelQuery = qIdx >= 0 ? fullUrl.substring(qIdx + 1) : "";
      const tunnel = new Guacamole.WebSocketTunnel(tunnelBase);
      const client = new Guacamole.Client(tunnel);

      tunnelRef.current = tunnel;
      clientRef.current = client;

      const display = client.getDisplay();
      const displayEl = display.getElement();
      displayEl.style.background = "#000";
      container.appendChild(displayEl);

      // Intercept custom NVR instructions from the backend before they reach
      // the Guacamole Client (which would ignore them).
      const clientHandler = tunnel.oninstruction;

      if (rewindSecs > 0) {
        setPhase("replaying");
      } else {
        setPhase("live");
      }

      tunnel.oninstruction = (opcode: string, args: string[]) => {
        // Custom: nvrheader — [paced_duration_ms, speed, buffer_depth_ms, offset_secs]
        if (opcode === "nvrheader") {
          const totalMs = parseInt(args[0] || "0", 10);
          replayTotalMsRef.current = totalMs;
          setReplayTotalMs(totalMs);
          const depthMs = parseInt(args[2] || "300000", 10);
          setBufferDepthMs(depthMs || MAX_BUFFER_SECS * 1000);
          const offSecs = parseInt(args[3] || "300", 10);
          setTimelineOffsetSecs(offSecs || 300);
          return;
        }
        // Custom: nvrprogress — current replay position in ms
        if (opcode === "nvrprogress") {
          const ms = parseInt(args[0] || "0", 10);
          replayProgressMsRef.current = ms;
          setReplayProgressMs(ms);
          return;
        }
        // Custom: nvrreplaydone — replay finished, now live
        if (opcode === "nvrreplaydone") {
          setPhase("live");
          return;
        }

        // Forward everything else to the Guacamole Client (skip when paused)
        if (clientHandler && !pausedRef.current) clientHandler(opcode, args);
      };

      client.onerror = (status: Guacamole.Status) => {
        setPhase("error");
        setErrorMsg(status?.message || "Connection error");
      };

      tunnel.onerror = (status: Guacamole.Status) => {
        setPhase("error");
        const code = status?.code;
        if (code === 519 || code === 520) {
          setErrorMsg("Session not found — it may have ended.");
        } else if (code === 515) {
          setErrorMsg("Authentication failed — your session may have expired.");
        } else {
          setErrorMsg(status?.message || "Tunnel error");
        }
      };

      tunnel.onstatechange = (state: number) => {
        if (state === Guacamole.Tunnel.CLOSED) {
          setPhase("ended");
        }
      };

      // Auto-scale display to fit the container
      const scaleToFit = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
          const dw = display.getWidth();
          const dh = display.getHeight();
          if (dw > 0 && dh > 0) {
            const scale = Math.min(w / dw, h / dh);
            display.scale(scale);
          }
        }
      };

      const resizeObserver = new ResizeObserver(scaleToFit);
      resizeObserver.observe(container);
      display.onresize = scaleToFit;

      // Elapsed timer
      timerRef.current = window.setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
      }, 1000);

      client.connect(tunnelQuery);

      return () => {
        resizeObserver.disconnect();
      };
    },
    // useAdminEndpoint is derived from searchParams once and stable for this view
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, cleanup]
  );

  // Initial connect
  useEffect(() => {
    connect(offset, speed);
    return cleanup;
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatMs = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  /* ── Timeline computations ───────────────────────────────────────── */
  // bufferDepthMs is the actual amount of data in the ring buffer.
  // The timeline always represents MAX_BUFFER_SECS (5 min) for
  // consistent marker placement. The "live edge" is at the right.
  const timelineTotalMs = MAX_BUFFER_SECS * 1000;

  // Where the current replay started on the timeline (ms from start).
  // e.g. offset=60 → playhead starts at (300-60)*1000 = 240000 of 300000
  const replayStartMs = Math.max(0, timelineTotalMs - timelineOffsetSecs * 1000);

  // Current playhead position: starts at replayStartMs, advances by progressMs
  const playheadMs = Math.min(timelineTotalMs, replayStartMs + replayProgressMs);
  const playheadPct = timelineTotalMs > 0 ? (playheadMs / timelineTotalMs) * 100 : 100;

  // Fraction of buffer actually filled (for the "available" region)
  const availablePct = Math.min(100, (bufferDepthMs / timelineTotalMs) * 100);

  /* ── Timeline drag handler ─────────────────────────────────────── */
  const timelineRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleTimelineSeek = useCallback(
    (clientX: number) => {
      const bar = timelineRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const clickedMs = pct * timelineTotalMs;
      // Convert to seconds-from-live-edge
      const secsFromEnd = Math.max(1, Math.round((timelineTotalMs - clickedMs) / 1000));
      // Clamp to available buffer
      const clamped = Math.min(secsFromEnd, Math.floor(bufferDepthMs / 1000));
      connect(clamped, speed);
    },
    [timelineTotalMs, bufferDepthMs, speed, connect]
  );

  // Attach global mousemove/mouseup while dragging
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isDragging.current) handleTimelineSeek(e.clientX);
    };
    const onUp = () => {
      isDragging.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [handleTimelineSeek]);

  return (
    <div className="flex flex-col h-screen bg-black">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-surface border-b border-border shrink-0 flex-wrap">
        <button
          onClick={() => navigate(-1)}
          className="text-txt-secondary hover:text-txt-primary text-sm flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back
        </button>

        <div className="h-4 w-px bg-border" />

        <div className="flex items-center gap-2 text-sm">
          <svg className="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="6" />
          </svg>
          <span className="font-medium text-txt-primary">{connectionName}</span>
          {username && <span className="text-txt-secondary">— {username}</span>}
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Status badge */}
        <div className="flex items-center gap-1.5">
          {phase === "connecting" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
              Connecting…
            </span>
          )}
          {phase === "replaying" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 animate-pulse">
              ⏪ Replaying…
            </span>
          )}
          {phase === "live" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 animate-pulse">
              ● LIVE
            </span>
          )}
          {phase === "ended" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-500/20 text-zinc-400">
              Session ended
            </span>
          )}
          {phase === "error" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
              Error
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Play / Pause */}
          {(phase === "replaying" || phase === "live") && (
            <button
              onClick={() => {
                const next = !paused;
                pausedRef.current = next;
                setPaused(next);
              }}
              title={paused ? "Resume" : "Pause"}
              className="text-xs px-2 py-1 rounded transition-colors bg-surface-elevated hover:bg-accent/20 text-txt-secondary hover:text-accent flex items-center gap-1"
            >
              {paused ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </button>
          )}

          <div className="h-4 w-px bg-border" />

          {/* Elapsed counter */}
          <span className="text-xs text-txt-secondary font-mono tabular-nums">
            {formatTime(elapsed)}
          </span>

          <div className="h-4 w-px bg-border" />

          {/* Rewind buttons */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-txt-secondary mr-1">Rewind:</span>
            {REWIND_MARKERS.map((secs) => (
              <button
                key={secs}
                onClick={() => connect(secs, speed)}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  offset === secs && phase === "replaying"
                    ? "bg-accent/30 text-accent"
                    : "bg-surface-elevated hover:bg-accent/20 text-txt-secondary hover:text-accent"
                }`}
              >
                {secs < 60 ? `${secs}s` : `${secs / 60}m`}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-border" />

          {/* Speed selector */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-txt-secondary">Speed:</span>
            {[1, 2, 4, 8].map((s) => (
              <button
                key={s}
                onClick={() => {
                  if (phase === "replaying") {
                    // Reconnect at the remaining replay position so we
                    // don't restart from the beginning of the rewind window.
                    const total = replayTotalMsRef.current;
                    const progress = replayProgressMsRef.current;
                    const remainingSecs = Math.max(1, Math.ceil((total - progress) / 1000));
                    connect(remainingSecs, s);
                  } else {
                    setSpeed(s);
                  }
                }}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                  speed === s
                    ? "bg-accent/30 text-accent font-medium"
                    : "bg-surface-elevated hover:bg-accent/20 text-txt-secondary hover:text-accent"
                }`}
              >
                {s}×
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-border" />

          <button
            onClick={() => connect(0, speed)}
            className="text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors font-medium"
          >
            Jump to Live
          </button>
        </div>
      </div>

      {/* ── Playback Timeline ─────────────────────────────────────── */}
      {(phase === "replaying" || phase === "live") && (
        <div className="px-4 py-2 bg-surface border-b border-border shrink-0">
          {/* Time labels */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-txt-secondary font-mono tabular-nums">-5:00</span>
            <span className="text-[10px] text-txt-secondary font-mono tabular-nums">
              {phase === "replaying" && replayTotalMs > 0 ? (
                <>
                  {formatMs(replayProgressMs)} / {formatMs(replayTotalMs)}{" "}
                  <span className="text-txt-secondary/60">({speed}×)</span>
                </>
              ) : phase === "replaying" ? (
                "Loading…"
              ) : (
                <span className="text-txt-secondary/60">Click or drag to rewind</span>
              )}
            </span>
            <span aria-hidden="true" className="text-[10px] text-red-400 font-mono font-medium">
              LIVE
            </span>
          </div>

          {/* Track */}
          <div
            ref={timelineRef}
            role="slider"
            aria-label="Playback timeline"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={availablePct}
            tabIndex={0}
            className="relative h-3 rounded-full cursor-pointer select-none group"
            style={{ background: "var(--color-surface-elevated)" }}
            onMouseDown={(e) => {
              isDragging.current = true;
              handleTimelineSeek(e.clientX);
            }}
          >
            {/* Available buffer region (right-aligned) */}
            <div
              className="absolute top-0 right-0 h-full rounded-full"
              style={{
                width: `${availablePct}%`,
                background: "rgba(255,255,255,0.06)",
              }}
            />

            {/* Progress fill: from replay start to current playhead */}
            {phase === "replaying" && (
              <div
                className="absolute top-0 h-full rounded-full transition-[width] duration-200 ease-linear"
                style={{
                  left: `${(replayStartMs / timelineTotalMs) * 100}%`,
                  width: `${Math.max(0, playheadPct - (replayStartMs / timelineTotalMs) * 100)}%`,
                  background: "var(--color-accent)",
                  opacity: 0.5,
                }}
              />
            )}

            {/* Rewind markers */}
            {REWIND_MARKERS.map((secs) => {
              const pct = ((MAX_BUFFER_SECS - secs) / MAX_BUFFER_SECS) * 100;
              const isActive = timelineOffsetSecs === secs && phase === "replaying";
              return (
                <div
                  key={secs}
                  className="absolute top-0 h-full flex flex-col items-center pointer-events-none"
                  style={{ left: `${pct}%`, transform: "translateX(-50%)" }}
                >
                  <div className={`w-px h-full ${isActive ? "bg-accent/60" : "bg-white/10"}`} />
                  <span
                    aria-hidden="true"
                    className={`text-[9px] mt-0.5 whitespace-nowrap ${
                      isActive ? "text-accent" : "text-txt-secondary/50"
                    }`}
                  >
                    {secs < 60 ? `${secs}s` : `${secs / 60}m`}
                  </span>
                </div>
              );
            })}

            {/* Live edge marker */}
            <div
              className="absolute top-0 right-0 h-full flex flex-col items-center pointer-events-none"
              style={{ transform: "translateX(50%)" }}
            >
              <div className="w-0.5 h-full bg-red-500/40 rounded-full" />
            </div>

            {/* Playhead thumb */}
            <div
              className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 bg-surface shadow-md shadow-black/30 transition-[left] duration-200 ease-linear group-hover:scale-110 ${
                phase === "live" ? "border-red-500" : "border-accent"
              }`}
              style={{
                left: `${phase === "live" ? 100 : playheadPct}%`,
                transform: `translateX(-50%) translateY(-50%)`,
              }}
            />
          </div>
        </div>
      )}

      {/* Error message with retry */}
      {phase === "error" && errorMsg && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm flex items-center gap-3">
          <span>{errorMsg}</span>
          <button
            onClick={() => connect(offset, speed)}
            className="text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Session ended overlay */}
      {phase === "ended" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/60">
          <div className="text-center">
            <p className="text-txt-secondary text-lg mb-4">Session has ended</p>
            <button
              onClick={() => navigate(-1)}
              className="px-4 py-2 rounded bg-accent text-white text-sm hover:bg-accent/90 transition-colors"
            >
              Return to Sessions
            </button>
          </div>
        </div>
      )}

      {/* Guacamole display */}
      <div ref={containerRef} className="flex-1 overflow-hidden flex items-center justify-center" />
    </div>
  );
}
