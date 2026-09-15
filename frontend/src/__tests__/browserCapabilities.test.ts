import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isWebPSupported,
  isH264Supported,
  _resetWebPSupportedCacheForTesting,
  _probeWebPSupportForTesting,
} from "../utils/browserCapabilities";

/**
 * Drive the decode probe by standing in for `Image`: jsdom does not
 * decode images, so the probe would otherwise never settle.
 */
function stubImage(outcome: "load" | "error", dims = { width: 1, height: 1 }) {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 0;
    height = 0;
    set src(_value: string) {
      queueMicrotask(() => {
        if (outcome === "load") {
          this.width = dims.width;
          this.height = dims.height;
          this.onload?.();
        } else {
          this.onerror?.();
        }
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("browserCapabilities", () => {
  beforeEach(() => {
    _resetWebPSupportedCacheForTesting(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports support once a WebP payload decodes", async () => {
    stubImage("load");
    _probeWebPSupportForTesting();
    await settle();

    expect(isWebPSupported()).toBe(true);
  });

  it("reports no support when the payload fails to decode", async () => {
    stubImage("error");
    _probeWebPSupportForTesting();
    await settle();

    expect(isWebPSupported()).toBe(false);
  });

  /**
   * A browser that decodes but cannot encode WebP — Safari for several
   * years — must not be downgraded. The old canvas.toDataURL check got
   * this wrong, which is why the probe decodes instead.
   */
  it("does not depend on WebP encode support", async () => {
    const toDataURL = vi.fn().mockReturnValue("data:image/png;base64,AAAA");
    vi.spyOn(document, "createElement").mockReturnValue({
      getContext: vi.fn().mockReturnValue({}),
      toDataURL,
    } as never);
    stubImage("load");
    _probeWebPSupportForTesting();
    await settle();

    expect(isWebPSupported()).toBe(true);
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it("assumes support while the probe is still in flight", () => {
    // Server-side default is also on, so an unresolved probe changes nothing.
    expect(isWebPSupported()).toBe(true);
  });

  it("treats a zero-sized decode as unsupported", async () => {
    stubImage("load", { width: 0, height: 0 });
    _probeWebPSupportForTesting();
    await settle();

    expect(isWebPSupported()).toBe(false);
  });

  it("survives an environment where Image construction throws", async () => {
    vi.stubGlobal(
      "Image",
      class {
        constructor() {
          throw new Error("blocked");
        }
      }
    );
    _probeWebPSupportForTesting();
    await settle();

    expect(isWebPSupported()).toBe(false);
  });
});

describe("isH264Supported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when window.VideoDecoder is defined", () => {
    vi.stubGlobal("VideoDecoder", class FakeVideoDecoder {});
    expect(isH264Supported()).toBe(true);
  });

  it("returns false when window.VideoDecoder is undefined", () => {
    vi.stubGlobal("VideoDecoder", undefined);
    expect(isH264Supported()).toBe(false);
  });
});
