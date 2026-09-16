/**
 * Browser capability detection for modern graphics and streaming formats.
 */

let webpSupportedCache: boolean | null = null;
let h264SupportedCache: boolean | null = null;

/** 1x1 lossy WebP. Decoding this is the only honest test of decode support. */
const WEBP_PROBE = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

/**
 * Baseline profile, level 5.1 — the same string the H.264 decoder
 * configures itself with. Probing anything else would answer a question
 * nobody asked.
 */
const H264_CODEC = "avc1.42E033";

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

/** Probe H.264 *decoding*, not merely the presence of WebCodecs. */
function probeH264Support(): void {
  const decoder = (
    globalThis as {
      VideoDecoder?: {
        isConfigSupported?: (c: { codec: string }) => Promise<{ supported?: boolean }>;
      };
    }
  ).VideoDecoder;

  if (!decoder?.isConfigSupported) {
    h264SupportedCache = false;
    return;
  }

  decoder
    .isConfigSupported({ codec: H264_CODEC })
    .then((result) => {
      h264SupportedCache = result.supported === true;
    })
    .catch(() => {
      h264SupportedCache = false;
    });
}

probeH264Support();

/**
 * Whether the browser can decode WebP. Optimistic while the probe is in
 * flight, which matches the server's own default; a brief wrong answer
 * costs bandwidth rather than correctness.
 */
export function isWebPSupported(): boolean {
  return webpSupportedCache ?? true;
}

/**
 * Whether the browser can decode the H.264 profile the RDP engine forwards.
 *
 * `typeof VideoDecoder !== "undefined"` is not enough: WebCodecs being
 * present says nothing about H.264 in particular, and a browser built
 * without the codec would claim support and then fail on the first frame.
 * `isConfigSupported` is the real answer but is asynchronous, so it runs
 * once at module load and callers read the cached result.
 *
 * Defaults to `false` while the probe is in flight — the opposite of the
 * WebP default, because guessing wrong here costs a black screen rather
 * than some bandwidth.
 */
export function isH264Supported(): boolean {
  return h264SupportedCache ?? false;
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

/**
 * Reset cached H.264 capability for unit testing.
 */
export function _resetH264SupportedCacheForTesting(value: boolean | null = null): void {
  h264SupportedCache = value;
}

/**
 * Re-run the H.264 config probe. Testing seam only.
 */
export function _probeH264SupportForTesting(): void {
  probeH264Support();
}
