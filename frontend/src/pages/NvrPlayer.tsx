import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import Guacamole from 'guacamole-common-js';
import { buildNvrObserveUrl } from '../api';

type Phase = 'connecting' | 'replaying' | 'live' | 'ended' | 'error';

export default function NvrPlayer() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const tunnelRef = useRef<Guacamole.Tunnel | null>(null);

  const [phase, setPhase] = useState<Phase>('connecting');
  const [offset, setOffset] = useState(() => {
    const o = searchParams.get('offset');
    return o ? parseInt(o, 10) : 300;
  });
  const [speed, setSpeed] = useState(4);
  const [errorMsg, setErrorMsg] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  // Replay progress state
  const [replayTotalMs, setReplayTotalMs] = useState(0);
  const [replayProgressMs, setReplayProgressMs] = useState(0);

  const connectionName = searchParams.get('name') || 'Session';
  const username = searchParams.get('user') || '';

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
  const connect = useCallback((rewindSecs: number, playbackSpeed: number) => {
    if (!sessionId || !containerRef.current) return;
    cleanup();

    const container = containerRef.current;
    container.innerHTML = '';

    setPhase('connecting');
    setErrorMsg('');
    setOffset(rewindSecs);
    setSpeed(playbackSpeed);
    setReplayTotalMs(0);
    setReplayProgressMs(0);
    elapsedRef.current = 0;
    setElapsed(0);

    const fullUrl = buildNvrObserveUrl(sessionId, rewindSecs, playbackSpeed);
    const qIdx = fullUrl.indexOf('?');
    const tunnelBase = qIdx >= 0 ? fullUrl.substring(0, qIdx) : fullUrl;
    const tunnelQuery = qIdx >= 0 ? fullUrl.substring(qIdx + 1) : '';
    const tunnel = new Guacamole.WebSocketTunnel(tunnelBase);
    const client = new Guacamole.Client(tunnel);

    tunnelRef.current = tunnel;
    clientRef.current = client;

    const display = client.getDisplay();
    const displayEl = display.getElement();
    displayEl.style.background = '#000';
    container.appendChild(displayEl);

    // Intercept custom NVR instructions from the backend before they reach
    // the Guacamole Client (which would ignore them).
    const clientHandler = tunnel.oninstruction;

    if (rewindSecs > 0) {
      setPhase('replaying');
    } else {
      setPhase('live');
    }

    tunnel.oninstruction = (opcode: string, args: string[]) => {
      // Custom: nvrheader — total replay duration + speed
      if (opcode === 'nvrheader') {
        const totalMs = parseInt(args[0] || '0', 10);
        setReplayTotalMs(totalMs);
        return;
      }
      // Custom: nvrprogress — current replay position in ms
      if (opcode === 'nvrprogress') {
        const ms = parseInt(args[0] || '0', 10);
        setReplayProgressMs(ms);
        return;
      }
      // Custom: nvrreplaydone — replay finished, now live
      if (opcode === 'nvrreplaydone') {
        setPhase('live');
        return;
      }

      // Forward everything else to the Guacamole Client
      if (clientHandler) clientHandler(opcode, args);
    };

    client.onerror = (status: Guacamole.Status) => {
      setPhase('error');
      setErrorMsg(status?.message || 'Connection error');
    };

    tunnel.onerror = (status: Guacamole.Status) => {
      setPhase('error');
      setErrorMsg(status?.message || 'Tunnel error');
    };

    tunnel.onstatechange = (state: number) => {
      if (state === Guacamole.Tunnel.CLOSED) {
        setPhase('ended');
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
  }, [sessionId, cleanup]);

  // Initial connect
  useEffect(() => {
    connect(offset, speed);
    return cleanup;
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatMs = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const replayPct = replayTotalMs > 0
    ? Math.min(100, (replayProgressMs / replayTotalMs) * 100)
    : 0;

  return (
    <div className="flex flex-col h-screen bg-black">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-surface border-b border-border shrink-0 flex-wrap">
        <button
          onClick={() => navigate(-1)}
          className="text-txt-secondary hover:text-txt-primary text-sm flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="h-4 w-px bg-border" />

        <div className="flex items-center gap-2 text-sm">
          <svg className="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="6" />
          </svg>
          <span className="font-medium text-txt-primary">{connectionName}</span>
          {username && (
            <span className="text-txt-secondary">— {username}</span>
          )}
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Status badge */}
        <div className="flex items-center gap-1.5">
          {phase === 'connecting' && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">Connecting…</span>
          )}
          {phase === 'replaying' && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 animate-pulse">
              ⏪ Replaying…
            </span>
          )}
          {phase === 'live' && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 animate-pulse">
              ● LIVE
            </span>
          )}
          {phase === 'ended' && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-500/20 text-zinc-400">Session ended</span>
          )}
          {phase === 'error' && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">Error</span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Elapsed counter */}
          <span className="text-xs text-txt-secondary font-mono tabular-nums">
            {formatTime(elapsed)}
          </span>

          <div className="h-4 w-px bg-border" />

          {/* Rewind buttons */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-txt-secondary mr-1">Rewind:</span>
            {[30, 60, 180, 300].map((secs) => (
              <button
                key={secs}
                onClick={() => connect(secs, speed)}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  offset === secs && phase === 'replaying'
                    ? 'bg-accent/30 text-accent'
                    : 'bg-surface-elevated hover:bg-accent/20 text-txt-secondary hover:text-accent'
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
                onClick={() => connect(offset, s)}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                  speed === s
                    ? 'bg-accent/30 text-accent font-medium'
                    : 'bg-surface-elevated hover:bg-accent/20 text-txt-secondary hover:text-accent'
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

      {/* Replay progress bar */}
      {phase === 'replaying' && replayTotalMs > 0 && (
        <div className="px-4 py-1.5 bg-surface border-b border-border flex items-center gap-3 shrink-0">
          <span className="text-xs text-txt-secondary font-mono w-10">
            {formatMs(replayProgressMs)}
          </span>
          <div className="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${replayPct}%` }}
            />
          </div>
          <span className="text-xs text-txt-secondary font-mono w-10 text-right">
            {formatMs(replayTotalMs)}
          </span>
          <span className="text-xs text-txt-secondary ml-1">
            ({speed}× speed)
          </span>
        </div>
      )}

      {/* Error message */}
      {phase === 'error' && errorMsg && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm">
          {errorMsg}
        </div>
      )}

      {/* Session ended overlay */}
      {phase === 'ended' && (
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
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-center justify-center"
      />
    </div>
  );
}
