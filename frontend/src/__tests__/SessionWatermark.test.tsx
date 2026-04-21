import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({
  getMe: vi.fn(),
}));

import SessionWatermark from "../components/SessionWatermark";
import { getMe } from "../api";

describe("SessionWatermark", () => {
  let mockObserveCallbacks: (() => void)[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockObserveCallbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function (cb: () => void) {
        mockObserveCallbacks.push(cb);
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
      })
    );
  });

  it("renders nothing when user is not loaded yet", () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { container } = render(<SessionWatermark />);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("renders nothing when watermark is disabled", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: "testuser",
      client_ip: "10.0.0.1",
      watermark_enabled: false,
    });
    const { container } = render(<SessionWatermark />);
    // Even after loading, canvas should not appear
    await waitFor(() => {
      expect(container.querySelector("canvas")).toBeNull();
    });
  });

  it("renders canvas when watermark is enabled", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: "testuser",
      client_ip: "10.0.0.1",
      watermark_enabled: true,
    });
    const { container } = render(<SessionWatermark />);
    await waitFor(() => {
      expect(container.querySelector("canvas")).toBeTruthy();
    });
  });

  it("canvas has pointer-events none", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: "testuser",
      client_ip: "10.0.0.1",
      watermark_enabled: true,
    });
    const { container } = render(<SessionWatermark />);
    await waitFor(() => {
      const canvas = container.querySelector("canvas");
      expect(canvas?.style.pointerEvents).toBe("none");
    });
  });

  it("paints watermark text with canvas context", async () => {
    const fillTextSpy = vi.fn();
    const mockCtx = {
      scale: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillText: fillTextSpy,
      measureText: vi.fn(() => ({ width: 200 })),
      font: "",
      fillStyle: "",
      textBaseline: "",
    };
    // Mock getContext on canvas prototype
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as any;

    // Give canvas elements a non-zero size
    Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", {
      value: 600,
      configurable: true,
    });

    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: "testuser",
      client_ip: "10.0.0.1",
      watermark_enabled: true,
    });
    const { container } = render(<SessionWatermark />);
    await waitFor(() => {
      expect(container.querySelector("canvas")).toBeTruthy();
    });

    // Canvas painting runs in useEffect — fillText should have been called
    expect(fillTextSpy).toHaveBeenCalled();
    expect(mockCtx.rotate).toHaveBeenCalled();
    expect(mockCtx.save).toHaveBeenCalled();
    expect(mockCtx.restore).toHaveBeenCalled();

    HTMLCanvasElement.prototype.getContext = origGetContext;
    delete (HTMLCanvasElement.prototype as any).clientWidth;
    delete (HTMLCanvasElement.prototype as any).clientHeight;
  });

  it("uses N/A for missing client_ip", async () => {
    const fillTextSpy = vi.fn();
    const mockCtx = {
      scale: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillText: fillTextSpy,
      measureText: vi.fn(() => ({ width: 200 })),
      font: "",
      fillStyle: "",
      textBaseline: "",
    };
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as any;
    Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", {
      value: 600,
      configurable: true,
    });

    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: "testuser",
      client_ip: "",
      watermark_enabled: true,
    });
    const { container } = render(<SessionWatermark />);
    await waitFor(() => {
      expect(container.querySelector("canvas")).toBeTruthy();
    });

    // Should have N/A in the text since client_ip is empty string (falsy)
    const callArgs = fillTextSpy.mock.calls;
    const hasNA = callArgs.some((args: any) => args[0].includes("N/A"));
    expect(hasNA).toBe(true);

    HTMLCanvasElement.prototype.getContext = origGetContext;
    delete (HTMLCanvasElement.prototype as any).clientWidth;
    delete (HTMLCanvasElement.prototype as any).clientHeight;
  });

  it("handles getMe rejection gracefully", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));
    const { container } = render(<SessionWatermark />);
    // Should not crash, and should render nothing
    await waitFor(() => {
      expect(container.querySelector("canvas")).toBeNull();
    });
  });
});
