import { useEffect, useRef, useState, useCallback } from "react";
import Guacamole from "guacamole-common-js";
import { buildRecordingStreamUrl, HistoricalRecording } from "../api";

interface Props {
  recording: HistoricalRecording;
  onClose: () => void;
  streamUrlBuilder?: (id: string) => string;
}

const SPEEDS = [1, 2, 4, 8] as const;
const SKIP_BUTTONS = [
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "3m", ms: 180_000 },
  { label: "5m", ms: 300_000 },
];

export default function HistoricalPlayer({ recording, onClose, streamUrlBuilder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const tunnelRef = useRef<Guacamole.Tunnel | null>(null);

  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [playing, setPlaying] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Progress tracking
  const [progressMs, setProgressMs] = useState(0);
  const [durationMs, setDurationMs] = useState(
    recording.duration_secs ? recording.duration_secs * 1000 : 0
  );
  const recordingEndedRef = useRef(false);
  const progressRef = useRef(0);

  const cleanup = useCallback(() => {
    if (tunnelRef.current) {
      tunnelRef.current.oninstruction = null;
      tunnelRef.current = null;
    }
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
  }, []);

  const connectWithParams = useCallback(
    (seekMs = 0, playbackSpeed = 1) => {
      if (!containerRef.current) return;
      cleanup();

      const container = containerRef.current;
      container.innerHTML = "";

      setLoading(true);
      setErrorMsg("");
      setPlaying(true);
      recordingEndedRef.current = false;

      let url = (streamUrlBuilder || buildRecordingStreamUrl)(recording.id);
      const params: string[] = [];
      if (seekMs > 0) params.push(`seek=${seekMs}`);
      if (playbackSpeed !== 1) params.push(`speed=${playbackSpeed}`);
      if (params.length > 0) {
        url += (url.includes("?") ? "&" : "?") + params.join("&");
      }
      const qIdx = url.indexOf("?");
      const tunnelBase = qIdx >= 0 ? url.substring(0, qIdx) : url;
      const tunnelQuery = qIdx >= 0 ? url.substring(qIdx + 1) : "";
      const tunnel = new Guacamole.WebSocketTunnel(tunnelBase);
      const client = new Guacamole.Client(tunnel);

      tunnelRef.current = tunnel;
      clientRef.current = client;

      const display = client.getDisplay();
      const displayEl = display.getElement();
      displayEl.style.background = "#000";
      container.appendChild(displayEl);

      // Intercept NVR-style instructions for metadata
      const clientHandler = tunnel.oninstruction;
      tunnel.oninstruction = (opcode: string, args: string[]) => {
        if (opcode === "nvrheader") {
          const total = parseInt(args[0] || "0", 10);
          setDurationMs(total);
          if (seekMs === 0) setLoading(false);
          return;
        }
        if (opcode === "nvrprogress") {
          const current = parseInt(args[0] || "0", 10);
          setProgressMs(current);
          progressRef.current = current;
          return;
        }
        if (opcode === "nvrseeked") {
          const pos = parseInt(args[0] || "0", 10);
          setProgressMs(pos);
          progressRef.current = pos;
          setLoading(false);
          return;
        }
        if (opcode === "nvrend") {
          recordingEndedRef.current = true;
          setProgressMs((prev) => durationMs || prev);
          setLoading(false);
          return;
        }
        if (clientHandler) clientHandler(opcode, args);
      };

      client.onerror = (status: Guacamole.Status) => {
        if (recordingEndedRef.current) return;
        setErrorMsg(status?.message || "Playback error");
        setLoading(false);
      };

      tunnel.onerror = (status: Guacamole.Status) => {
        if (recordingEndedRef.current) return;
        setErrorMsg(status?.message || "Tunnel error");
        setLoading(false);
      };

      tunnel.onstatechange = (state: number) => {
        if (state === 2 && recordingEndedRef.current) {
          setErrorMsg("");
        }
      };

      // Auto-scale
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

      client.connect(tunnelQuery);

      return () => {
        resizeObserver.disconnect();
      };
    },
    [recording.id, cleanup, streamUrlBuilder, durationMs]
  );

  // Initial connect
  useEffect(() => {
    connectWithParams(0, 1);
    return cleanup;
    // Re-run only when the recording itself changes; cleanup/connectWithParams identities would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.id]);

  // Track fullscreen changes
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!cardRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      cardRef.current.requestFullscreen();
    }
  }, []);

  const handleSpeedChange = useCallback(
    (newSpeed: number) => {
      setSpeed(newSpeed);
      connectWithParams(progressRef.current, newSpeed);
    },
    [connectWithParams]
  );

  const handleSkip = useCallback(
    (deltaMs: number) => {
      const target = Math.max(0, Math.min(progressRef.current + deltaMs, durationMs));
      setSpeed((prev) => {
        connectWithParams(target, prev);
        return prev;
      });
    },
    [durationMs, connectWithParams]
  );

  const formatMs = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const progressPct = durationMs > 0 ? (progressMs / durationMs) * 100 : 0;
  const controlsDisabled = loading || recordingEndedRef.current;

  return (
    <div role="dialog" aria-modal="true" aria-label="Recording playback" className="player-overlay">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-transparent border-0"
      />
      <div
        ref={cardRef}
        className={`player-card animate-in zoom-in duration-200 relative ${isFullscreen ? "player-card-fullscreen" : ""}`}
      >
        {/* Header */}
        <div className="player-header">
          <div className="flex flex-col">
            <h3 className="text-base font-bold text-txt-primary leading-tight">
              {recording.connection_name}
            </h3>
            <span className="text-[10px] uppercase tracking-widest text-txt-tertiary font-bold mt-0.5">
              Recorded Session — {recording.username}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleFullscreen}
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-tertiary text-txt-tertiary hover:text-txt-primary transition-colors"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
                </svg>
              )}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-tertiary text-txt-tertiary hover:text-txt-primary transition-colors"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Video Area */}
        <div className="player-container">
          <div ref={containerRef} className="w-full h-full flex items-center justify-center" />

          {loading && (
            <div className="player-loading">
              <div className="spinner" />
            </div>
          )}

          {errorMsg && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20">
              <div className="bg-danger/10 border border-danger/30 p-4 rounded-lg flex items-center gap-3">
                <svg
                  className="w-6 h-6 text-danger"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div className="text-danger font-medium">{errorMsg}</div>
                <button
                  onClick={() => connectWithParams(0, speed)}
                  className="btn btn-sm btn-secondary ml-2"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="player-controls">
          <div className="player-timeline">
            <div className="player-timeline-progress" style={{ width: `${progressPct}%` }} />
          </div>

          <div className="flex items-center justify-between gap-3">
            {/* Left: play/pause + time */}
            <div className="flex items-center gap-3">
              <button
                className={`w-9 h-9 flex items-center justify-center rounded-full bg-accent text-white shadow-lg transition-transform active:scale-95 ${controlsDisabled ? "opacity-50 pointer-events-none" : ""}`}
                onClick={() => {
                  if (!tunnelRef.current) return;
                  if (playing) {
                    tunnelRef.current.sendMessage("nvrpause");
                    setPlaying(false);
                  } else {
                    tunnelRef.current.sendMessage("nvrresume");
                    setPlaying(true);
                  }
                }}
              >
                {playing ? (
                  <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                  </svg>
                ) : (
                  <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <div className="text-xs font-mono text-txt-secondary flex items-center gap-1">
                <span className="text-txt-primary font-bold">{formatMs(progressMs)}</span>
                <span className="opacity-40">/</span>
                <span>{formatMs(durationMs)}</span>
              </div>
            </div>

            {/* Center: skip controls */}
            <div className="flex items-center gap-1">
              {SKIP_BUTTONS.map(({ label, ms }) => (
                <button
                  key={`back-${label}`}
                  className={`player-skip-btn ${controlsDisabled ? "opacity-50 pointer-events-none" : ""}`}
                  onClick={() => handleSkip(-ms)}
                  title={`Skip back ${label}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
                  </svg>
                  {label}
                </button>
              ))}
              <div className="w-px h-5 bg-border mx-1" />
              {SKIP_BUTTONS.map(({ label, ms }) => (
                <button
                  key={`fwd-${label}`}
                  className={`player-skip-btn ${controlsDisabled ? "opacity-50 pointer-events-none" : ""}`}
                  onClick={() => handleSkip(ms)}
                  title={`Skip forward ${label}`}
                >
                  {label}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M13 6v12l8.5-6L13 6zM4 18l8.5-6L4 6v12z" />
                  </svg>
                </button>
              ))}
            </div>

            {/* Right: speed selector */}
            <div className="flex items-center gap-1">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`player-speed-btn ${speed === s ? "player-speed-btn-active" : ""} ${controlsDisabled ? "opacity-50 pointer-events-none" : ""}`}
                  onClick={() => handleSpeedChange(s)}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
