import { useEffect, useRef, useState, useCallback } from 'react';
import Guacamole from 'guacamole-common-js';
import { buildRecordingStreamUrl, HistoricalRecording } from '../api';

interface Props {
  recording: HistoricalRecording;
  onClose: () => void;
  streamUrlBuilder?: (id: string) => string;
}

export default function HistoricalPlayer({ recording, onClose, streamUrlBuilder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const tunnelRef = useRef<Guacamole.Tunnel | null>(null);

  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [playing, setPlaying] = useState(true);
  
  // Progress tracking
  const [progressMs, setProgressMs] = useState(0);
  const [durationMs, setDurationMs] = useState(recording.duration_secs ? recording.duration_secs * 1000 : 0);
  const recordingEndedRef = useRef(false);

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

  const connect = useCallback(() => {
    if (!containerRef.current) return;
    cleanup();

    const container = containerRef.current;
    container.innerHTML = '';

    setLoading(true);
    setErrorMsg('');
    setPlaying(true);
    recordingEndedRef.current = false;

    const url = (streamUrlBuilder || buildRecordingStreamUrl)(recording.id);
    const qIdx = url.indexOf('?');
    const tunnelBase = qIdx >= 0 ? url.substring(0, qIdx) : url;
    const tunnelQuery = qIdx >= 0 ? url.substring(qIdx + 1) : '';
    const tunnel = new Guacamole.WebSocketTunnel(tunnelBase);
    const client = new Guacamole.Client(tunnel);

    tunnelRef.current = tunnel;
    clientRef.current = client;

    const display = client.getDisplay();
    const displayEl = display.getElement();
    displayEl.style.background = '#000';
    container.appendChild(displayEl);

    // Intercept NVR-style instructions for metadata
    const clientHandler = tunnel.oninstruction;
    tunnel.oninstruction = (opcode: string, args: string[]) => {
      if (opcode === 'nvrheader') {
        const total = parseInt(args[0] || '0', 10);
        setDurationMs(total);
        setLoading(false);
        return;
      }
      if (opcode === 'nvrprogress') {
        const current = parseInt(args[0] || '0', 10);
        setProgressMs(current);
        return;
      }
      if (opcode === 'nvrend') {
        recordingEndedRef.current = true;
        setProgressMs(prev => durationMs || prev);
        setLoading(false);
        return;
      }
      if (clientHandler) clientHandler(opcode, args);
    };

    client.onerror = (status: Guacamole.Status) => {
      if (recordingEndedRef.current) return;
      setErrorMsg(status?.message || 'Playback error');
      setLoading(false);
    };

    tunnel.onerror = (status: Guacamole.Status) => {
      if (recordingEndedRef.current) return;
      setErrorMsg(status?.message || 'Tunnel error');
      setLoading(false);
    };

    tunnel.onstatechange = (state: number) => {
      // Suppress errors from normal end-of-recording close (CLOSED = 2)
      if (state === 2 && recordingEndedRef.current) {
        // Clean disconnect after nvrend — clear any error that may have
        // been set by a race between the close frame and our handler.
        setErrorMsg('');
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
  }, [recording.id, cleanup]);

  useEffect(() => {
    connect();
    return cleanup;
  }, [recording.id, connect, cleanup]);

  const formatMs = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progressPct = durationMs > 0 ? (progressMs / durationMs) * 100 : 0;

  return (
    <div className="player-overlay" onClick={onClose}>
      <div className="player-card animate-in zoom-in duration-200" onClick={e => e.stopPropagation()}>
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
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-tertiary text-txt-tertiary hover:text-txt-primary transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
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
                <svg className="w-6 h-6 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <div className="text-danger font-medium">{errorMsg}</div>
                <button onClick={connect} className="btn btn-sm btn-secondary ml-2">Retry</button>
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="player-controls">
          <div className="player-timeline">
            <div 
              className="player-timeline-progress" 
              style={{ width: `${progressPct}%` }}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button 
                className={`w-10 h-10 flex items-center justify-center rounded-full bg-accent text-white shadow-lg transition-transform active:scale-95 ${loading || recordingEndedRef.current ? 'opacity-50 pointer-events-none' : ''}`}
                onClick={() => {
                  if (!tunnelRef.current) return;
                  if (playing) {
                    tunnelRef.current.sendMessage('nvrpause');
                    setPlaying(false);
                  } else {
                    tunnelRef.current.sendMessage('nvrresume');
                    setPlaying(true);
                  }
                }}
              >
                {playing ? (
                  <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
                ) : (
                  <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                )}
              </button>

              <div className="text-sm font-mono text-txt-secondary flex items-center gap-1.5">
                <span className="text-txt-primary font-bold">{formatMs(progressMs)}</span>
                <span className="opacity-40">/</span>
                <span>{formatMs(durationMs)}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="px-3 py-1 bg-surface-tertiary rounded border border-border text-[10px] font-bold uppercase tracking-wider text-txt-tertiary">
                {recording.storage_type} storage
              </div>
              <div className="px-3 py-1 bg-accent/10 rounded border border-accent/20 text-[10px] font-bold uppercase tracking-wider text-accent">
                {new Date(recording.started_at).toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
