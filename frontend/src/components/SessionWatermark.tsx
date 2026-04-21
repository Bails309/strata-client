import { useEffect, useRef, useState } from "react";
import { getMe, MeResponse } from "../api";

/**
 * Semi-transparent diagonal watermark overlay rendered on top of a session.
 * Displays the logged-in user's name, IP address, and a rotating timestamp.
 * Uses `pointer-events: none` so it never intercepts mouse/touch input.
 */
interface SessionWatermarkProps {
  /** Per-connection watermark override: 'inherit' | 'on' | 'off' */
  connectionWatermark?: string;
}

export default function SessionWatermark({
  connectionWatermark = "inherit",
}: SessionWatermarkProps) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [timestamp, setTimestamp] = useState(() => formatTimestamp());
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fetch user info (cached for session lifetime)
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Update the timestamp every 30 seconds
  useEffect(() => {
    const id = setInterval(() => setTimestamp(formatTimestamp()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Paint the repeating watermark onto a canvas
  useEffect(() => {
    if (!user) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const text = `${user.username}  •  ${user.client_ip || "N/A"}  •  ${timestamp}`;
    const fontSize = 14;
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = "middle";

    const metrics = ctx.measureText(text);
    const textWidth = metrics.width + 80; // spacing between repetitions
    const rowHeight = 100;

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 6); // -30 degrees

    // Cover the full diagonal extent
    const diag = Math.sqrt(w * w + h * h);
    const startX = -diag;
    const startY = -diag;

    // Dark pass (visible on light backgrounds)
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    for (let y = startY; y < diag; y += rowHeight) {
      for (let x = startX; x < diag; x += textWidth) {
        ctx.fillText(text, x, y);
      }
    }

    // Light pass offset by 1px (visible on dark backgrounds)
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    for (let y = startY; y < diag; y += rowHeight) {
      for (let x = startX; x < diag; x += textWidth) {
        ctx.fillText(text, x + 1, y + 1);
      }
    }

    ctx.restore();
  }, [user, timestamp]);

  // Re-paint on resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      // Trigger a re-render to repaint
      setTimestamp(formatTimestamp());
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Per-connection override: 'on' always shows, 'off' always hides, 'inherit' uses global
  if (connectionWatermark === "off") return null;
  if (!user || (connectionWatermark === "inherit" && !user.watermark_enabled)) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 9999,
      }}
    />
  );
}

function formatTimestamp(): string {
  return new Date().toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
