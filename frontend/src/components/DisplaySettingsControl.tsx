import { useState, useEffect, useCallback } from "react";
import { GuacSession } from "./SessionManager";
import { requestFullscreenWithLock, exitFullscreenWithUnlock } from "../utils/keyboardLock";

export interface ResolutionStop {
  width: number;
  height: number;
  label: string;
  desc: string;
}

export const RESOLUTION_STOPS: readonly ResolutionStop[] = [
  { width: 800, height: 600, label: "800 × 600", desc: "4:3 SVGA" },
  { width: 1024, height: 768, label: "1024 × 768", desc: "4:3 XGA" },
  { width: 1280, height: 720, label: "1280 × 720", desc: "16:9 HD" },
  { width: 1366, height: 768, label: "1366 × 768", desc: "16:9 Laptop" },
  { width: 1600, height: 900, label: "1600 × 900", desc: "16:9 HD+" },
  { width: 1920, height: 1080, label: "1920 × 1080", desc: "16:9 FHD" },
  { width: 2560, height: 1440, label: "2560 × 1440", desc: "16:9 2K QHD" },
  { width: 3840, height: 2160, label: "3840 × 2160", desc: "16:9 4K UHD" },
  { width: 0, height: 0, label: "Full Screen", desc: "Dynamic (Match Window)" },
] as const;

export const FULLSCREEN_INDEX = RESOLUTION_STOPS.length - 1;

export const ZOOM_PRESETS: { label: string; value: number | "fit" }[] = [
  { label: "Fit", value: "fit" },
  { label: "100%", value: 1.0 },
  { label: "125%", value: 1.25 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2.0 },
];

interface Props {
  session: GuacSession;
  onClose?: () => void;
}

export default function DisplaySettingsControl({ session }: Props) {
  // Find initial slider index
  const getInitialIndex = useCallback(() => {
    const res = session.targetResolution;
    if (!res || res === "auto") return FULLSCREEN_INDEX;
    const match = RESOLUTION_STOPS.findIndex(
      (s) => s.width === res.width && s.height === res.height
    );
    return match !== -1 ? match : FULLSCREEN_INDEX;
  }, [session.targetResolution]);

  const [sliderIndex, setSliderIndex] = useState<number>(getInitialIndex);
  const [zoom, setZoom] = useState<number | "fit">(session.zoomScale ?? "fit");
  const [isFullscreen, setIsFullscreen] = useState<boolean>(!!document.fullscreenElement);
  const [liveWidth, setLiveWidth] = useState<number>(1920);
  const [liveHeight, setLiveHeight] = useState<number>(1080);

  // Sync state with session and live display
  useEffect(() => {
    setSliderIndex(getInitialIndex());
    setZoom(session.zoomScale ?? "fit");

    try {
      const display = session.client?.getDisplay();
      if (display) {
        setLiveWidth(display.getWidth() || 1920);
        setLiveHeight(display.getHeight() || 1080);
      }
    } catch {
      // Ignore in mock/test environments
    }
  }, [session, getInitialIndex]);

  // Watch document fullscreen changes
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const handleSliderChange = (idx: number) => {
    setSliderIndex(idx);
    const stop = RESOLUTION_STOPS[idx];
    const targetRes =
      idx === FULLSCREEN_INDEX ? "auto" : { width: stop.width, height: stop.height };

    session.applyDisplayConfig?.(targetRes, zoom);
  };

  const handleZoomChange = (newZoom: number | "fit") => {
    setZoom(newZoom);
    const stop = RESOLUTION_STOPS[sliderIndex];
    const targetRes =
      sliderIndex === FULLSCREEN_INDEX ? "auto" : { width: stop.width, height: stop.height };
    session.applyDisplayConfig?.(targetRes, newZoom);
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await exitFullscreenWithUnlock(document);
      } else {
        await requestFullscreenWithLock(document.documentElement);
        handleSliderChange(FULLSCREEN_INDEX);
      }
    } catch {
      // Ignore fullscreen failure
    }
  };

  const currentStop = RESOLUTION_STOPS[sliderIndex];
  const isFullScreenStop = sliderIndex === FULLSCREEN_INDEX;

  return (
    <div className="flex flex-col gap-3.5 text-txt-primary">
      {/* ── Hyper-V Style Resolution Slider ── */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[0.7rem] uppercase text-txt-tertiary font-semibold tracking-wide">
            Display Resolution
          </span>
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded ${
              isFullScreenStop
                ? "bg-accent/20 text-accent-light border border-accent/30"
                : "bg-white/10 text-txt-primary"
            }`}
          >
            {currentStop.label}
          </span>
        </div>

        <p className="text-[0.68rem] text-txt-tertiary mb-2">
          {isFullScreenStop
            ? "Dynamic: automatically sizes to match your window or monitor."
            : `${currentStop.desc} (${currentStop.width} × ${currentStop.height} px)`}
        </p>

        {/* Range Slider */}
        <div className="px-1 py-1">
          <input
            type="range"
            min={0}
            max={FULLSCREEN_INDEX}
            step={1}
            value={sliderIndex}
            onChange={(e) => handleSliderChange(Number(e.target.value))}
            className="w-full h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-accent-light focus:outline-none"
            aria-label="Resolution slider"
          />

          {/* Slider Labels (Hyper-V VMConnect style) */}
          <div className="flex justify-between text-[0.6rem] text-txt-tertiary font-medium mt-1.5 px-0.5">
            <span>Small (800×600)</span>
            <span>1080p</span>
            <span className={isFullScreenStop ? "text-accent-light font-bold" : ""}>
              Full Screen ⤢
            </span>
          </div>
        </div>
      </section>

      {/* ── Zoom / Scale Selector ── */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[0.7rem] uppercase text-txt-tertiary font-semibold tracking-wide">
            Display Zoom / Scale
          </span>
          <span className="text-[0.68rem] font-mono text-txt-secondary">
            {zoom === "fit" ? "Fit to Window" : `${Math.round(zoom * 100)}%`}
          </span>
        </div>

        <div className="grid grid-cols-5 gap-1.5">
          {ZOOM_PRESETS.map((preset) => {
            const active = zoom === preset.value;
            return (
              <button
                key={preset.label}
                type="button"
                className={`py-1 text-xs font-medium rounded border transition-all ${
                  active
                    ? "bg-accent/25 border-accent text-accent-light shadow-sm"
                    : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"
                }`}
                onClick={() => handleZoomChange(preset.value)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Fullscreen Action & Current Status ── */}
      <section className="pt-2 border-t border-white/10 flex flex-col gap-2">
        <button
          type="button"
          onClick={toggleFullscreen}
          className="btn-sm w-full flex items-center justify-center gap-2 py-1.5 text-xs font-semibold rounded bg-white/5 hover:bg-white/10 border border-white/15 transition-all"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {isFullscreen ? (
              <>
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </>
            ) : (
              <>
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </>
            )}
          </svg>
          {isFullscreen ? "Exit Full Screen" : "Enter Full Screen"}
        </button>

        <div className="flex justify-between items-center text-[0.65rem] text-txt-tertiary">
          <span>Active Remote Desktop:</span>
          <span className="font-mono text-txt-secondary">
            {liveWidth} × {liveHeight} px
          </span>
        </div>
      </section>
    </div>
  );
}
