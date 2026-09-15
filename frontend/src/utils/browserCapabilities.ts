/**
 * Browser capability detection for modern graphics and streaming formats.
 */

let webpSupportedCache: boolean | null = null;

/** 1x1 lossy WebP. Decoding this is the only honest test of decode support. */
const WEBP_PROBE = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

/**
 * Probe WebP *decoding*.
 *
 * `canvas.toDataURL("image/webp")` — the obvious synchronous check —
 * reports whether the browser can **encode** WebP, which is a different
 * capability: Safari decoded WebP for years before it could encode it,
 * and would have been downgraded to PNG for no reason.
 *
 * Decoding is inherently asynchronous, so this runs once at module load
 * and callers read the cached answer.
 */
function probeWebPSupport(): void {
  try {
    const img = new Image();
    img.onload = () => {
      webpSupportedCache = img.width > 0 && img.height > 0;
    };
    img.onerror = () => {
      webpSupportedCache = false;
    };
    img.src = WEBP_PROBE;
  } catch {
    webpSupportedCache = false;
  }
}

probeWebPSupport();

/**
 * Whether the browser can decode WebP. Optimistic while the probe is in
 * flight, which matches the server's own default; a brief wrong answer
 * costs bandwidth rather than correctness.
 */
export function isWebPSupported(): boolean {
  return webpSupportedCache ?? true;
}

/**
 * Whether the browser supports hardware-accelerated H.264 video decoding via WebCodecs.
 */
export function isH264Supported(): boolean {
  return typeof window !== "undefined" && typeof (window as any).VideoDecoder !== "undefined";
}

/**
 * Reset cached capability for unit testing.
 */
export function _resetWebPSupportedCacheForTesting(value: boolean | null = null): void {
  webpSupportedCache = value;
}

/**
 * Re-run the decode probe. Testing seam only.
 */
export function _probeWebPSupportForTesting(): void {
  probeWebPSupport();
}
