import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DisplaySettingsControl, {
  RESOLUTION_STOPS,
  FULLSCREEN_INDEX,
} from "../components/DisplaySettingsControl";

describe("DisplaySettingsControl (Hyper-V Style Resolution & Zoom)", () => {
  let mockSession: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = {
      id: "sess-test",
      name: "Test RDP Host",
      protocol: "rdp",
      client: {
        getDisplay: vi.fn(() => ({
          getWidth: () => 1920,
          getHeight: () => 1080,
          scale: vi.fn(),
        })),
        sendSize: vi.fn(),
      },
      targetResolution: "auto",
      zoomScale: "fit",
      applyDisplayConfig: vi.fn(),
    };
  });

  it("renders the resolution slider and zoom options", () => {
    render(<DisplaySettingsControl session={mockSession} />);

    expect(screen.getByText("Display Resolution")).toBeInTheDocument();
    expect(screen.getByText("Display Zoom / Scale")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /resolution slider/i })).toBeInTheDocument();
    expect(screen.getByText("Full Screen")).toBeInTheDocument();
    expect(screen.getByText("Small (800×600)")).toBeInTheDocument();
  });

  it("defaults to Full Screen stop when targetResolution is auto", () => {
    render(<DisplaySettingsControl session={mockSession} />);

    const slider = screen.getByRole("slider", { name: /resolution slider/i }) as HTMLInputElement;
    expect(slider.value).toBe(String(FULLSCREEN_INDEX));
    expect(screen.getByText("Full Screen")).toBeInTheDocument();
  });

  it("updates resolution when slider moves to a fixed stop (e.g. 1080p)", () => {
    render(<DisplaySettingsControl session={mockSession} />);

    const slider = screen.getByRole("slider", { name: /resolution slider/i });
    const idx1080p = RESOLUTION_STOPS.findIndex((s) => s.label.includes("1920 × 1080"));

    fireEvent.change(slider, { target: { value: String(idx1080p) } });

    expect(mockSession.applyDisplayConfig).toHaveBeenCalledWith(
      { width: 1920, height: 1080 },
      "fit"
    );
  });

  it("updates resolution back to auto when sliding all the way to the right", () => {
    mockSession.targetResolution = { width: 1280, height: 720 };
    render(<DisplaySettingsControl session={mockSession} />);

    const slider = screen.getByRole("slider", { name: /resolution slider/i });
    fireEvent.change(slider, { target: { value: String(FULLSCREEN_INDEX) } });

    expect(mockSession.applyDisplayConfig).toHaveBeenCalledWith("auto", "fit");
  });

  it("triggers zoom scale change when clicking zoom buttons", async () => {
    const user = userEvent.setup();
    render(<DisplaySettingsControl session={mockSession} />);

    const zoom150Btn = screen.getByRole("button", { name: "150%" });
    await user.click(zoom150Btn);

    expect(mockSession.applyDisplayConfig).toHaveBeenCalledWith("auto", 1.5);
  });

  it("renders live active resolution status", () => {
    render(<DisplaySettingsControl session={mockSession} />);
    expect(screen.getByText("1920 × 1080 px")).toBeInTheDocument();
  });
});
