import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GuacSession,
  isScalePassthroughEnabled,
  setScalePassthroughEnabled,
  remoteDpi,
  remoteDisplayMetrics,
  sendSizeWithDpi,
  sendSizeFromCss,
} from "../components/SessionManager";

vi.mock("guacamole-common-js", () => ({ default: {} }));
vi.mock("../api", () => ({ createTunnelTicket: vi.fn() }));

function setDpr(value: number) {
  Object.defineProperty(window, "devicePixelRatio", { value, configurable: true });
}

function fakeSession() {
  const sendMessage = vi.fn();
  return {
    session: { tunnel: { state: 1, sendMessage } } as unknown as GuacSession,
    sendMessage,
  };
}

describe("remote display scaling", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setDpr(1);
  });

  it("does not forward the local scale by default", () => {
    expect(isScalePassthroughEnabled()).toBe(false);
    expect(remoteDpi(1.25)).toBe(96);
  });

  it("forwards the local scale once opted in", () => {
    setScalePassthroughEnabled(true);
    expect(isScalePassthroughEnabled()).toBe(true);
    expect(remoteDpi(1.25)).toBe(120);
    expect(remoteDpi(2)).toBe(192);
  });

  // The 125% regression: a 1920-wide monitor reports 1536 CSS pixels. The
  // target must still be asked for 1920 real pixels, and — because the
  // size already accounts for the scale — at 100% so Windows does not
  // draw its UI 25% larger on top.
  it("asks a 125% display for its real pixels at 100% scale", () => {
    const metrics = remoteDisplayMetrics(1536, 864, 1.25);
    expect(metrics).toEqual({ width: 1920, height: 1080, dpi: 96 });
  });

  it("keeps the real pixels but reports the scale when opted in", () => {
    setScalePassthroughEnabled(true);
    const metrics = remoteDisplayMetrics(1536, 864, 1.25);
    expect(metrics).toEqual({ width: 1920, height: 1080, dpi: 120 });
  });

  it("leaves an unscaled display untouched", () => {
    expect(remoteDisplayMetrics(1920, 1080, 1)).toEqual({
      width: 1920,
      height: 1080,
      dpi: 96,
    });
  });

  it("sends real pixels and an unscaled dpi over the tunnel", () => {
    const { session, sendMessage } = fakeSession();
    sendSizeFromCss(session, 1536, 864, 1.25);
    expect(sendMessage).toHaveBeenCalledWith("size", 1920, 1080, 96);
  });

  it("sends the scaled dpi over the tunnel when opted in", () => {
    setScalePassthroughEnabled(true);
    const { session, sendMessage } = fakeSession();
    sendSizeFromCss(session, 1536, 864, 1.25);
    expect(sendMessage).toHaveBeenCalledWith("size", 1920, 1080, 120);
  });

  it("does not resize a disconnected tunnel", () => {
    const sendMessage = vi.fn();
    const session = { tunnel: { state: 2, sendMessage } } as unknown as GuacSession;
    sendSizeWithDpi(session, 1920, 1080, 1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to sendSize when the tunnel cannot carry a dpi", () => {
    const sendSize = vi.fn();
    const session = { client: { sendSize } } as unknown as GuacSession;
    sendSizeFromCss(session, 1536, 864, 1.25);
    expect(sendSize).toHaveBeenCalledWith(1920, 1080);
  });

  it("survives storage being unavailable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => setScalePassthroughEnabled(true)).not.toThrow();
    expect(isScalePassthroughEnabled()).toBe(false);
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
