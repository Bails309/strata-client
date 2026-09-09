//! Server-side terminal rasteriser for Guacamole Wire Compatibility Mode.
//!
//! The Guacamole protocol has no text primitive — the only way to put
//! characters on a client canvas is to send pixels. `guacd` does this
//! with Pango and Cairo; this module does it with `alacritty_terminal`
//! for VT state and `fontdue` for glyphs.
//!
//! This exists for one reason: existing `guacamole-common-js` clients.
//! Native Direct Streaming Mode sends the raw PTY byte stream to
//! `xterm.js` and never allocates a pixel, and once every client speaks
//! it this module can be deleted.
//!
//! ```text
//!   PTY bytes ─► vte parser ─► Term grid ─► damage ─► PNG ─► ImageUpdate
//! ```

pub mod font;
pub mod palette;
pub mod typescript;

use std::collections::VecDeque;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermDamage};
use alacritty_terminal::vte::ansi::{CursorShape, Processor};
use async_trait::async_trait;
use bytes::Bytes;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};

use crate::engine::{InputEvent, Protocol, ProtocolEngine, TargetEvent};
use crate::error::EngineError;

pub use font::{CellMetrics, TerminalFont};
pub use palette::{Palette, Pixel};
pub use typescript::Typescript;

/// Default font size for the rendered grid.
pub const DEFAULT_FONT_SIZE_PX: f32 = 16.0;

/// Scrollback retained by the emulator.
const SCROLLBACK_LINES: usize = 5_000;

/// Terminal appearance, as the connection's parameters describe it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalAppearance {
    /// Colours, from `color-scheme`.
    pub palette: Palette,
    /// Lines of history, from `scrollback`.
    pub scrollback: usize,
}

impl Default for TerminalAppearance {
    fn default() -> Self {
        Self {
            palette: Palette::default(),
            scrollback: SCROLLBACK_LINES,
        }
    }
}

/// Grid geometry, the shape `alacritty_terminal` wants.
#[derive(Debug, Clone, Copy)]
struct TermSize {
    columns: usize,
    screen_lines: usize,
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines + SCROLLBACK_LINES
    }

    fn screen_lines(&self) -> usize {
        self.screen_lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

/// The emulator emits events for bells, title changes and clipboard
/// requests. None of them affect rendering, and the ones that matter to
/// a session travel on their own channels.
#[derive(Clone, Copy)]
struct IgnoreEvents;

impl EventListener for IgnoreEvents {
    fn send_event(&self, _event: Event) {}
}

/// A resolved cell, ready to draw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CellSnapshot {
    ch: char,
    fg: Pixel,
    bg: Pixel,
    flags: Flags,
}

/// A damaged region, in cell coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    col: usize,
    row: usize,
    cols: usize,
    rows: usize,
}

/// Turns a PTY byte stream into image updates.
pub struct TerminalRenderer {
    term: Term<IgnoreEvents>,
    parser: Processor,
    font: TerminalFont,
    palette: Palette,
    cell: CellMetrics,
    cols: usize,
    rows: usize,
    last_cursor: Option<(usize, usize)>,
    last_snapshot: Vec<CellSnapshot>,
    force_full: bool,
}

impl std::fmt::Debug for TerminalRenderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalRenderer")
            .field("cols", &self.cols)
            .field("rows", &self.rows)
            .field("cell", &self.cell)
            .finish()
    }
}

impl TerminalRenderer {
    /// Create a renderer over a `cols` x `rows` grid.
    #[must_use]
    pub fn new(font: TerminalFont, cols: usize, rows: usize) -> Self {
        Self::with_appearance(font, cols, rows, &TerminalAppearance::default())
    }

    /// Create a renderer with an explicit palette and scrollback depth.
    #[must_use]
    pub fn with_appearance(
        font: TerminalFont,
        cols: usize,
        rows: usize,
        appearance: &TerminalAppearance,
    ) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let size = TermSize {
            columns: cols,
            screen_lines: rows,
        };
        let cell = font.metrics();
        Self {
            term: Term::new(
                Config {
                    scrolling_history: appearance.scrollback,
                    ..Config::default()
                },
                &size,
                IgnoreEvents,
            ),
            parser: Processor::new(),
            font,
            palette: appearance.palette,
            cell,
            cols,
            rows,
            last_cursor: None,
            last_snapshot: Vec::new(),
            force_full: true,
        }
    }

    /// Cell geometry in pixels.
    #[must_use]
    pub fn cell_metrics(&self) -> CellMetrics {
        self.cell
    }

    /// Full display size in pixels.
    #[must_use]
    pub fn pixel_size(&self) -> (u32, u32) {
        (
            self.cols as u32 * self.cell.width,
            self.rows as u32 * self.cell.height,
        )
    }

    /// Grid dimensions that fit the given pixel geometry.
    #[must_use]
    pub fn grid_for(&self, width_px: u32, height_px: u32) -> (usize, usize) {
        (
            (width_px / self.cell.width.max(1)).max(1) as usize,
            (height_px / self.cell.height.max(1)).max(1) as usize,
        )
    }

    /// Resize the grid, forcing a full repaint on the next flush.
    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        self.term.resize(TermSize {
            columns: cols,
            screen_lines: rows,
        });
        self.force_full = true;
    }

    /// Feed PTY bytes and return the resulting image updates.
    pub fn advance(&mut self, bytes: &[u8]) -> Result<Vec<TargetEvent>, EngineError> {
        self.parser.advance(&mut self.term, bytes);
        self.flush()
    }

    /// Render whatever is currently damaged.
    pub fn flush(&mut self) -> Result<Vec<TargetEvent>, EngineError> {
        let rects = self.take_damage();
        if rects.is_empty() {
            return Ok(Vec::new());
        }

        let cells = self.snapshot();
        // alacritty reports the cursor's line as damaged on every poll,
        // so damage alone would have us re-encoding a PNG for an idle
        // terminal several times a second. Compare what we are about to
        // draw against what the client already has.
        let mut events = Vec::new();
        for rect in rects {
            if self.rect_unchanged(&cells, rect) {
                continue;
            }
            events.push(self.render(&cells, rect)?);
        }
        self.last_snapshot = cells;
        Ok(events)
    }

    fn rect_unchanged(&self, cells: &[CellSnapshot], rect: Rect) -> bool {
        if self.last_snapshot.len() != cells.len() {
            return false;
        }
        (rect.row..rect.row + rect.rows).all(|row| {
            let start = row * self.cols + rect.col;
            let end = start + rect.cols;
            cells[start..end] == self.last_snapshot[start..end]
        })
    }

    /// Collect damaged regions, merging contiguous runs of lines.
    fn take_damage(&mut self) -> Vec<Rect> {
        let full = Rect {
            col: 0,
            row: 0,
            cols: self.cols,
            rows: self.rows,
        };
        let cursor = self.cursor_position();

        if std::mem::take(&mut self.force_full) {
            self.term.reset_damage();
            self.last_cursor = cursor;
            return vec![full];
        }

        let mut lines: Vec<(usize, usize, usize)> = Vec::new();
        match self.term.damage() {
            TermDamage::Full => {
                self.term.reset_damage();
                self.last_cursor = cursor;
                return vec![full];
            }
            TermDamage::Partial(iter) => {
                for bounds in iter {
                    if bounds.line < self.rows {
                        lines.push((bounds.line, bounds.left, bounds.right));
                    }
                }
            }
        }
        self.term.reset_damage();

        // When the cursor moves, repaint both the cell it landed on and
        // the one it left. alacritty does not always damage both, and a
        // missed repaint leaves a second cursor on screen for the rest
        // of the session. A stationary cursor adds no damage, so an idle
        // terminal produces no frames at all.
        if cursor != self.last_cursor {
            for pos in [cursor, self.last_cursor].into_iter().flatten() {
                lines.push((pos.1, pos.0, pos.0));
            }
            self.last_cursor = cursor;
        }

        if lines.is_empty() {
            return Vec::new();
        }

        lines.sort_unstable();
        let mut rects: Vec<Rect> = Vec::new();
        for (line, left, right) in lines {
            let right = right.min(self.cols.saturating_sub(1));
            match rects.last_mut() {
                // Extend the run when this line touches the previous one.
                Some(last) if line <= last.row + last.rows => {
                    let end_col = last.col + last.cols;
                    let new_col = last.col.min(left);
                    let new_end = end_col.max(right + 1);
                    last.cols = new_end - new_col;
                    last.col = new_col;
                    last.rows = (line + 1) - last.row;
                }
                _ => rects.push(Rect {
                    col: left,
                    row: line,
                    cols: right + 1 - left.min(right),
                    rows: 1,
                }),
            }
        }
        rects
    }

    fn cursor_position(&self) -> Option<(usize, usize)> {
        let content = self.term.renderable_content();
        if content.cursor.shape == CursorShape::Hidden {
            return None;
        }
        let line = content.cursor.point.line.0;
        let col = content.cursor.point.column.0;
        if line < 0 || line as usize >= self.rows || col >= self.cols {
            return None;
        }
        Some((col, line as usize))
    }

    /// Resolve the whole grid into drawable cells.
    fn snapshot(&self) -> Vec<CellSnapshot> {
        let blank = CellSnapshot {
            ch: ' ',
            fg: self.palette.foreground,
            bg: self.palette.background,
            flags: Flags::empty(),
        };
        let mut cells = vec![blank; self.cols * self.rows];

        let content = self.term.renderable_content();
        let cursor = if content.cursor.shape == CursorShape::Hidden {
            None
        } else {
            Some(content.cursor.point)
        };

        for indexed in content.display_iter {
            let line = indexed.point.line.0;
            if line < 0 {
                continue;
            }
            let (row, col) = (line as usize, indexed.point.column.0);
            if row >= self.rows || col >= self.cols {
                continue;
            }

            let cell = indexed.cell;
            let mut fg = self.palette.resolve(cell.fg);
            let mut bg = self.palette.resolve(cell.bg);
            if cell.flags.contains(Flags::DIM) {
                fg = fg.dim();
            }
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            let ch = if cell.flags.contains(Flags::HIDDEN) {
                ' '
            } else {
                cell.c
            };

            cells[row * self.cols + col] = CellSnapshot {
                ch,
                fg,
                bg,
                flags: cell.flags,
            };
        }

        // A block cursor is drawn as an inversion, which is what every
        // terminal does and costs no extra glyph work.
        if let Some(point) = cursor {
            let line = point.line.0;
            if line >= 0 {
                let (row, col) = (line as usize, point.column.0);
                if row < self.rows && col < self.cols {
                    let cell = &mut cells[row * self.cols + col];
                    std::mem::swap(&mut cell.fg, &mut cell.bg);
                }
            }
        }

        cells
    }

    /// Draw one rectangle and encode it as PNG.
    fn render(&mut self, cells: &[CellSnapshot], rect: Rect) -> Result<TargetEvent, EngineError> {
        let (cw, ch_px) = (self.cell.width as usize, self.cell.height as usize);
        let baseline = self.cell.baseline as i32;
        let (px_w, px_h) = (rect.cols * cw, rect.rows * ch_px);
        let grid_cols = self.cols;
        let mut buf = vec![0u8; px_w * px_h * 4];

        for row in 0..rect.rows {
            for col in 0..rect.cols {
                let cell = cells[(rect.row + row) * grid_cols + rect.col + col];
                let (ox, oy) = (col * cw, row * ch_px);
                fill_cell(&mut buf, px_w, ox, oy, cw, ch_px, cell.bg);

                if cell.ch != ' ' && cell.ch != '\0' {
                    let glyph = self.font.glyph(cell.ch);
                    let pen_x = ox as i32 + glyph.left;
                    let glyph_top = oy as i32 + baseline - (glyph.bottom + glyph.height as i32);
                    for gy in 0..glyph.height {
                        for gx in 0..glyph.width {
                            let alpha = glyph.coverage[gy * glyph.width + gx];
                            if alpha == 0 {
                                continue;
                            }
                            blend_pixel(
                                &mut buf,
                                px_w,
                                px_h,
                                pen_x + gx as i32,
                                glyph_top + gy as i32,
                                cell.fg,
                                alpha,
                            );
                        }
                    }
                }

                if cell.flags.intersects(Flags::ALL_UNDERLINES) {
                    let y = oy + baseline.max(0) as usize + 1;
                    fill_cell(
                        &mut buf,
                        px_w,
                        ox,
                        y.min(px_h.saturating_sub(1)),
                        cw,
                        1,
                        cell.fg,
                    );
                }
                if cell.flags.contains(Flags::STRIKEOUT) {
                    let y = oy + ch_px / 2;
                    fill_cell(
                        &mut buf,
                        px_w,
                        ox,
                        y.min(px_h.saturating_sub(1)),
                        cw,
                        1,
                        cell.fg,
                    );
                }
            }
        }

        let mut png = Vec::new();
        // Terminal frames are latency-sensitive and mostly flat colour:
        // fast compression beats a smaller payload here.
        PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive)
            .write_image(&buf, px_w as u32, px_h as u32, ExtendedColorType::Rgba8)
            .map_err(|e| EngineError::Protocol(format!("png encode failed: {e}")))?;

        Ok(TargetEvent::ImageUpdate {
            x: (rect.col * cw) as i32,
            y: (rect.row * ch_px) as i32,
            mimetype: "image/png",
            data: Bytes::from(png),
        })
    }
}

fn fill_cell(
    buf: &mut [u8],
    stride_px: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    colour: Pixel,
) {
    for row in y..(y + height) {
        for col in x..(x + width) {
            let Some(offset) = pixel_offset(buf, stride_px, col, row) else {
                continue;
            };
            buf[offset] = colour.r;
            buf[offset + 1] = colour.g;
            buf[offset + 2] = colour.b;
            buf[offset + 3] = 0xff;
        }
    }
}

fn blend_pixel(
    buf: &mut [u8],
    stride_px: usize,
    height_px: usize,
    x: i32,
    y: i32,
    colour: Pixel,
    alpha: u8,
) {
    if x < 0 || y < 0 || x as usize >= stride_px || y as usize >= height_px {
        return;
    }
    let Some(offset) = pixel_offset(buf, stride_px, x as usize, y as usize) else {
        return;
    };
    let a = u16::from(alpha);
    let inv = 255 - a;
    for (i, channel) in [colour.r, colour.g, colour.b].into_iter().enumerate() {
        let dst = u16::from(buf[offset + i]);
        buf[offset + i] = ((u16::from(channel) * a + dst * inv) / 255) as u8;
    }
    buf[offset + 3] = 0xff;
}

fn pixel_offset(buf: &[u8], stride_px: usize, x: usize, y: usize) -> Option<usize> {
    if x >= stride_px {
        return None;
    }
    let offset = (y * stride_px + x) * 4;
    (offset + 3 < buf.len()).then_some(offset)
}

/// Wraps a character-oriented engine and renders its output to images.
///
/// Placed between the engine and the frame encoder so neither has to
/// know the other's mode: the SSH engine always emits raw bytes, and in
/// Wire Compatibility Mode this turns them into `ImageUpdate`s that
/// [`GuacWireEncoder`](crate::transport::GuacWireEncoder) already knows
/// how to frame.
pub struct RasterisingEngine {
    inner: Box<dyn ProtocolEngine>,
    renderer: TerminalRenderer,
    pending: VecDeque<TargetEvent>,
    /// Server-side record of the raw output, when one was configured.
    typescript: Option<Typescript>,
}

impl RasterisingEngine {
    /// Wrap `inner`, rendering into a `width_px` x `height_px` display.
    #[must_use]
    pub fn new(
        inner: Box<dyn ProtocolEngine>,
        font: TerminalFont,
        width_px: u32,
        height_px: u32,
    ) -> Self {
        Self::with_appearance(
            inner,
            font,
            width_px,
            height_px,
            &TerminalAppearance::default(),
        )
    }

    /// Wrap `inner` with an explicit palette and scrollback depth.
    #[must_use]
    pub fn with_appearance(
        inner: Box<dyn ProtocolEngine>,
        font: TerminalFont,
        width_px: u32,
        height_px: u32,
        appearance: &TerminalAppearance,
    ) -> Self {
        let cell = font.metrics();
        let cols = (width_px / cell.width.max(1)).max(1) as usize;
        let rows = (height_px / cell.height.max(1)).max(1) as usize;
        let renderer = TerminalRenderer::with_appearance(font, cols, rows, appearance);

        // The client needs a correctly sized layer before any image
        // lands on it, so the first event out is always the geometry.
        let (w, h) = renderer.pixel_size();
        let mut pending = VecDeque::new();
        pending.push_back(TargetEvent::Resized {
            width: w,
            height: h,
        });

        Self {
            inner,
            renderer,
            pending,
            typescript: None,
        }
    }

    /// Record raw terminal output to `typescript` as well as rendering it.
    #[must_use]
    pub fn with_typescript(mut self, typescript: Typescript) -> Self {
        self.typescript = Some(typescript);
        self
    }

    /// Grid dimensions currently rendered.
    #[must_use]
    pub fn grid_size(&self) -> (usize, usize) {
        (self.renderer.cols, self.renderer.rows)
    }
}

#[async_trait]
impl ProtocolEngine for RasterisingEngine {
    fn protocol(&self) -> Protocol {
        self.inner.protocol()
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        if let InputEvent::Resize { width, height } = input {
            let (cols, rows) = self.renderer.grid_for(width, height);
            self.renderer.resize(cols, rows);
            let (w, h) = self.renderer.pixel_size();
            self.pending.push_back(TargetEvent::Resized {
                width: w,
                height: h,
            });
            self.pending.extend(self.renderer.flush()?);
        }
        self.inner.handle_input(input).await
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            // Cancel-safe: all partial state lives in `self.pending`, so
            // dropping this future in the actor's `select!` loses nothing.
            let Some(event) = self.inner.next_event().await? else {
                return Ok(None);
            };
            match event {
                TargetEvent::TerminalOutput(bytes) => {
                    if let Some(typescript) = self.typescript.as_mut() {
                        // A recording failure must not end the session:
                        // the operator is mid-task and losing the shell
                        // is worse than losing the transcript.
                        if let Err(err) = typescript.write(&bytes).await {
                            tracing::warn!(error = %err, "typescript write failed");
                        }
                    }
                    self.pending.extend(self.renderer.advance(&bytes)?);
                }
                other => self.pending.push_back(other),
            }
        }
    }

    async fn shutdown(&mut self) -> Result<(), EngineError> {
        if let Some(typescript) = self.typescript.as_mut() {
            if let Err(err) = typescript.finish().await {
                tracing::warn!(error = %err, "typescript could not be closed");
            }
        }
        self.inner.shutdown().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::mock::MockEngine;

    fn renderer(cols: usize, rows: usize) -> TerminalRenderer {
        let font = TerminalFont::discover(DEFAULT_FONT_SIZE_PX)
            .expect("tests need a monospace font; install fonts-dejavu-core");
        TerminalRenderer::new(font, cols, rows)
    }

    fn png_dimensions(event: &TargetEvent) -> (u32, u32, i32, i32) {
        let TargetEvent::ImageUpdate { x, y, data, .. } = event else {
            panic!("expected an image update, got {event:?}");
        };
        // PNG IHDR: width and height are big-endian u32 at offset 16.
        let w = u32::from_be_bytes(data[16..20].try_into().unwrap());
        let h = u32::from_be_bytes(data[20..24].try_into().unwrap());
        (w, h, *x, *y)
    }

    #[test]
    fn the_first_flush_paints_the_whole_screen() {
        let mut renderer = renderer(80, 24);
        let events = renderer.advance(b"hello").unwrap();
        assert_eq!(events.len(), 1);

        let (w, h, x, y) = png_dimensions(&events[0]);
        let (full_w, full_h) = renderer.pixel_size();
        assert_eq!((w, h), (full_w, full_h));
        assert_eq!((x, y), (0, 0));
    }

    #[test]
    fn later_writes_only_repaint_damaged_lines() {
        let mut renderer = renderer(80, 24);
        renderer.advance(b"first").unwrap();

        let events = renderer.advance(b"more text").unwrap();
        assert!(!events.is_empty());
        let (_, h, _, _) = png_dimensions(&events[0]);
        let (_, full_h) = renderer.pixel_size();
        assert!(
            h < full_h,
            "a single-line write repainted {h}px of a {full_h}px screen"
        );
    }

    #[test]
    fn output_with_no_change_produces_no_frames() {
        let mut renderer = renderer(80, 24);
        renderer.advance(b"x").unwrap();
        assert!(renderer.advance(b"").unwrap().is_empty());
    }

    #[test]
    fn images_are_valid_png() {
        let mut renderer = renderer(40, 10);
        let events = renderer.advance(b"hello world").unwrap();
        let TargetEvent::ImageUpdate { data, mimetype, .. } = &events[0] else {
            panic!("expected an image update");
        };
        assert_eq!(*mimetype, "image/png");
        assert_eq!(&data[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn colour_escapes_reach_the_rendered_pixels() {
        // Fill the screen red, then green, and confirm the encoded
        // frames differ — i.e. SGR is actually being honoured.
        let mut red = renderer(20, 5);
        let red_frames = red.advance(b"\x1b[41m          ").unwrap();
        let mut green = renderer(20, 5);
        let green_frames = green.advance(b"\x1b[42m          ").unwrap();

        let TargetEvent::ImageUpdate { data: a, .. } = &red_frames[0] else {
            panic!("expected an image update");
        };
        let TargetEvent::ImageUpdate { data: b, .. } = &green_frames[0] else {
            panic!("expected an image update");
        };
        assert_ne!(a, b, "red and green backgrounds encoded identically");
    }

    #[test]
    fn resizing_forces_a_full_repaint_at_the_new_size() {
        let mut renderer = renderer(80, 24);
        renderer.advance(b"hello").unwrap();

        renderer.resize(40, 12);
        let events = renderer.flush().unwrap();
        assert_eq!(events.len(), 1);
        let (w, h, _, _) = png_dimensions(&events[0]);
        assert_eq!((w, h), renderer.pixel_size());
    }

    #[test]
    fn a_collapsed_grid_never_becomes_zero_sized() {
        let mut renderer = renderer(1, 1);
        renderer.resize(0, 0);
        assert_eq!(renderer.grid_for(0, 0), (1, 1));
        let (w, h) = renderer.pixel_size();
        assert!(w > 0 && h > 0);
    }

    #[test]
    fn control_sequences_never_panic() {
        let mut renderer = renderer(20, 5);
        for chunk in [
            &b"\x1b[999;999H"[..],
            &b"\x1b[2J\x1b[H"[..],
            &b"\x1b]0;title\x07"[..],
            &b"\x1b[38;2;1;2;3mrgb"[..],
            &b"\x1b[?1049h"[..],
            &b"\xff\xfe\xfd"[..],
            "\u{1b}[1m\u{4e2d}\u{6587}".as_bytes(),
        ] {
            let _ = renderer.advance(chunk).unwrap();
        }
    }

    #[tokio::test]
    async fn the_wrapper_sizes_the_layer_before_drawing() {
        let (engine, events, _inputs) = MockEngine::new(Protocol::Ssh);
        let font = TerminalFont::discover(DEFAULT_FONT_SIZE_PX).unwrap();
        let mut wrapper = RasterisingEngine::new(Box::new(engine), font, 640, 480);

        let first = wrapper.next_event().await.unwrap().unwrap();
        assert!(matches!(first, TargetEvent::Resized { .. }));

        events
            .send(TargetEvent::TerminalOutput(Bytes::from_static(b"$ ls\r\n")))
            .unwrap();
        let second = wrapper.next_event().await.unwrap().unwrap();
        assert!(matches!(second, TargetEvent::ImageUpdate { .. }));
    }

    #[tokio::test]
    async fn non_terminal_events_pass_through_untouched() {
        let (engine, events, _inputs) = MockEngine::new(Protocol::Ssh);
        let font = TerminalFont::discover(DEFAULT_FONT_SIZE_PX).unwrap();
        let mut wrapper = RasterisingEngine::new(Box::new(engine), font, 320, 240);
        let _ = wrapper.next_event().await.unwrap();

        events
            .send(TargetEvent::Disconnected {
                reason: "bye".to_owned(),
            })
            .unwrap();
        let event = wrapper.next_event().await.unwrap().unwrap();
        assert_eq!(
            event,
            TargetEvent::Disconnected {
                reason: "bye".to_owned()
            }
        );
    }

    #[tokio::test]
    async fn resizing_the_client_reflows_the_grid() {
        let (engine, _events, inputs) = MockEngine::new(Protocol::Ssh);
        let font = TerminalFont::discover(DEFAULT_FONT_SIZE_PX).unwrap();
        let mut wrapper = RasterisingEngine::new(Box::new(engine), font, 640, 480);
        let before = wrapper.grid_size();

        wrapper
            .handle_input(InputEvent::Resize {
                width: 1280,
                height: 720,
            })
            .await
            .unwrap();

        assert_ne!(wrapper.grid_size(), before);
        // The resize must still reach the target so the PTY agrees.
        assert_eq!(inputs.lock().unwrap().len(), 1);
    }
}
