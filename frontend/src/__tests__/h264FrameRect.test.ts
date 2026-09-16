import { describe, expect, it } from "vitest";

import { h264SourceRect } from "../lib/h264FrameRect";

describe("h264SourceRect", () => {
  it("crops macroblock padding instead of scaling the frame to fit", () => {
    // The live case: a 1920x950 desktop codes as 1920x960, and Windows sets
    // no crop metadata, so visibleRect reports the padded size too.
    const rect = h264SourceRect(
      {
        visibleRect: { x: 0, y: 0, width: 1920, height: 960 },
        codedWidth: 1920,
        codedHeight: 960,
      },
      1920,
      950
    );

    expect(rect).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 950 });
  });

  it("keeps source and destination the same size so the blit is 1:1", () => {
    // Any difference between the two is a resample, which is what made
    // text hazy: a ~1% rescale blends every row into its neighbour.
    const destWidth = 1920;
    const destHeight = 950;
    const rect = h264SourceRect(
      { visibleRect: { x: 0, y: 0, width: 1920, height: 960 } },
      destWidth,
      destHeight
    );

    expect(rect.sw).toBe(destWidth);
    expect(rect.sh).toBe(destHeight);
  });

  it("honours a crop origin rather than assuming the frame starts at 0,0", () => {
    const rect = h264SourceRect(
      { visibleRect: { x: 8, y: 16, width: 200, height: 100 } },
      200,
      100
    );

    expect(rect).toEqual({ sx: 8, sy: 16, sw: 200, sh: 100 });
  });

  it("falls back to the display size when no crop is reported", () => {
    const rect = h264SourceRect(
      { displayWidth: 640, displayHeight: 480, codedWidth: 640, codedHeight: 480 },
      640,
      480
    );

    expect(rect).toEqual({ sx: 0, sy: 0, sw: 640, sh: 480 });
  });

  it("falls back to the coded size when the display size is absent", () => {
    const rect = h264SourceRect({ codedWidth: 320, codedHeight: 240 }, 320, 240);

    expect(rect).toEqual({ sx: 0, sy: 0, sw: 320, sh: 240 });
  });

  it("never reads past a frame smaller than the destination", () => {
    // Drawing 1920 wide from a 640-wide frame would sample undefined pixels.
    const rect = h264SourceRect({ codedWidth: 640, codedHeight: 480 }, 1920, 950);

    expect(rect.sw).toBe(640);
    expect(rect.sh).toBe(480);
  });

  it("uses the frame size when the instruction carries no geometry", () => {
    const rect = h264SourceRect({ visibleRect: { x: 0, y: 0, width: 800, height: 600 } }, 0, 0);

    expect(rect).toEqual({ sx: 0, sy: 0, sw: 800, sh: 600 });
  });
});
