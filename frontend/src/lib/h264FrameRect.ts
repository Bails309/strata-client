/**
 * Source rectangle for drawing a decoded H.264 frame.
 *
 * H.264 codes in 16x16 macroblocks, so a 1920x950 picture is coded as
 * 1920x960. Windows sets no frame-cropping metadata for RDP because
 * MS-RDPEGFX makes the surface command's destination rectangle
 * authoritative, which leaves `codedHeight` -- and often `visibleRect` --
 * reporting the padded size. Scaling that to the destination resamples
 * every pixel and draws the padding rows, which decode green.
 *
 * Cropping to the destination keeps source and destination the same size,
 * so the caller can blit 1:1.
 */

/** The parts of a WebCodecs `VideoFrame` this needs. */
export interface DecodedFrameLike {
  visibleRect?: { x: number; y: number; width: number; height: number } | null;
  displayWidth?: number;
  displayHeight?: number;
  codedWidth?: number;
  codedHeight?: number;
}

export interface FrameSourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * @param frame decoded frame
 * @param instructionWidth width from the `h264` instruction, if any
 * @param instructionHeight height from the `h264` instruction, if any
 */
export function h264SourceRect(
  frame: DecodedFrameLike,
  instructionWidth?: number,
  instructionHeight?: number,
): FrameSourceRect {
  const crop = frame.visibleRect;

  const frameWidth = crop
    ? crop.width
    : (frame.displayWidth ?? 0) || (frame.codedWidth ?? 0);
  const frameHeight = crop
    ? crop.height
    : (frame.displayHeight ?? 0) || (frame.codedHeight ?? 0);

  const destWidth = instructionWidth || frameWidth;
  const destHeight = instructionHeight || frameHeight;

  return {
    sx: crop ? crop.x : 0,
    sy: crop ? crop.y : 0,
    sw: Math.max(0, Math.min(destWidth, frameWidth)),
    sh: Math.max(0, Math.min(destHeight, frameHeight)),
  };
}
