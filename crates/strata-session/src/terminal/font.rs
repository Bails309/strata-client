//! Monospace font loading and glyph rasterisation.
//!
//! A terminal grid needs glyph bitmaps and nothing else — no shaping, no
//! bidi, no ligatures — so this uses `fontdue` directly rather than a
//! full text-layout stack.
//!
//! Fonts are loaded from the filesystem rather than vendored into the
//! binary: embedding a font would put its licence into our distribution
//! and our NOTICE file for a capability that only Wire Compatibility
//! Mode needs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use fontdue::{Font, FontSettings};

use crate::engine::keymap::CellSize;
use crate::error::EngineError;

/// Locations searched by [`TerminalFont::discover`], in order.
///
/// Deployment note: the backend container must install a monospace font
/// (`fonts-dejavu-core` on Debian) for Wire Compatibility Mode to work.
pub const FONT_SEARCH_PATHS: &[&str] = &[
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
];

/// A rasterised glyph: coverage values, one byte per pixel.
#[derive(Debug, Clone)]
pub struct Glyph {
    /// Bitmap width in pixels.
    pub width: usize,
    /// Bitmap height in pixels.
    pub height: usize,
    /// Offset of the bitmap's left edge from the pen position.
    pub left: i32,
    /// Offset of the bitmap's bottom edge from the baseline.
    pub bottom: i32,
    /// Coverage, row-major, `width * height` bytes.
    pub coverage: Vec<u8>,
}

/// Cell geometry derived from the font's own metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellMetrics {
    /// Cell width in pixels.
    pub width: u32,
    /// Cell height in pixels.
    pub height: u32,
    /// Distance from the cell's top edge to the baseline.
    pub baseline: u32,
}

impl From<CellMetrics> for CellSize {
    fn from(metrics: CellMetrics) -> Self {
        Self {
            width: metrics.width,
            height: metrics.height,
        }
    }
}

/// A loaded monospace font plus its glyph cache.
pub struct TerminalFont {
    font: Font,
    size_px: f32,
    metrics: CellMetrics,
    cache: HashMap<char, Glyph>,
}

impl std::fmt::Debug for TerminalFont {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalFont")
            .field("size_px", &self.size_px)
            .field("metrics", &self.metrics)
            .field("cached_glyphs", &self.cache.len())
            .finish()
    }
}

impl TerminalFont {
    /// Load a font from an explicit path.
    pub fn load(path: impl AsRef<Path>, size_px: f32) -> Result<Self, EngineError> {
        let path = path.as_ref();
        let data = std::fs::read(path).map_err(EngineError::Transport)?;
        Self::from_bytes(&data, size_px)
    }

    /// Load the first monospace font found in [`FONT_SEARCH_PATHS`].
    pub fn discover(size_px: f32) -> Result<Self, EngineError> {
        for candidate in FONT_SEARCH_PATHS {
            let path = PathBuf::from(candidate);
            if path.is_file() {
                return Self::load(&path, size_px);
            }
        }
        Err(EngineError::Protocol(format!(
            "no monospace font found; searched {}. Install fonts-dejavu-core, \
             or use Native Direct Streaming Mode, which needs no server-side font.",
            FONT_SEARCH_PATHS.join(", ")
        )))
    }

    /// Build from font file bytes.
    pub fn from_bytes(data: &[u8], size_px: f32) -> Result<Self, EngineError> {
        let font = Font::from_bytes(
            data,
            FontSettings {
                scale: size_px,
                ..FontSettings::default()
            },
        )
        .map_err(|e| EngineError::Protocol(format!("font parse failed: {e}")))?;

        let line = font.horizontal_line_metrics(size_px).ok_or_else(|| {
            EngineError::Protocol(
                "font has no horizontal metrics; not usable as a terminal font".into(),
            )
        })?;

        // Monospace: every advance is the same, so 'M' speaks for all.
        let advance = font.metrics('M', size_px).advance_width;
        let width = advance.ceil().max(1.0) as u32;
        let height = (line.ascent - line.descent + line.line_gap).ceil().max(1.0) as u32;
        let baseline = line.ascent.ceil().max(0.0) as u32;

        Ok(Self {
            font,
            size_px,
            metrics: CellMetrics {
                width,
                height,
                baseline,
            },
            cache: HashMap::new(),
        })
    }

    /// Cell geometry for this font at its configured size.
    #[must_use]
    pub fn metrics(&self) -> CellMetrics {
        self.metrics
    }

    /// Rasterise `ch`, caching the result.
    pub fn glyph(&mut self, ch: char) -> &Glyph {
        self.cache.entry(ch).or_insert_with(|| {
            let (metrics, coverage) = self.font.rasterize(ch, self.size_px);
            Glyph {
                width: metrics.width,
                height: metrics.height,
                left: metrics.xmin,
                bottom: metrics.ymin,
                coverage,
            }
        })
    }

    /// Number of glyphs currently cached.
    #[must_use]
    pub fn cached_glyphs(&self) -> usize {
        self.cache.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test here needs a real font file. Rather than skipping
    /// silently when one is missing — which would let a broken renderer
    /// ship green — the helper fails loudly with the install hint.
    fn font() -> TerminalFont {
        TerminalFont::discover(16.0).expect(
            "tests need a monospace font; install fonts-dejavu-core in the test environment",
        )
    }

    #[test]
    fn discovery_reports_where_it_looked() {
        // Exercised via load() on a path that cannot exist, so the error
        // text is checked without depending on the host having no fonts.
        let err = TerminalFont::load("/nonexistent/font.ttf", 16.0).unwrap_err();
        assert!(matches!(err, EngineError::Transport(_)));
    }

    #[test]
    fn garbage_is_rejected_as_a_font() {
        let err = TerminalFont::from_bytes(b"not a font at all", 16.0).unwrap_err();
        assert!(matches!(err, EngineError::Protocol(_)));
    }

    #[test]
    fn cell_metrics_are_positive_and_plausible() {
        let font = font();
        let metrics = font.metrics();
        assert!(metrics.width > 0 && metrics.height > 0);
        assert!(metrics.baseline > 0);
        assert!(
            metrics.baseline <= metrics.height,
            "baseline {} must sit inside a {}px cell",
            metrics.baseline,
            metrics.height
        );
        // A 16px monospace cell is taller than it is wide.
        assert!(metrics.height > metrics.width);
    }

    #[test]
    fn glyphs_rasterise_and_are_cached() {
        let mut font = font();
        assert_eq!(font.cached_glyphs(), 0);

        let glyph = font.glyph('M').clone();
        assert!(glyph.width > 0 && glyph.height > 0);
        assert_eq!(glyph.coverage.len(), glyph.width * glyph.height);
        assert!(glyph.coverage.iter().any(|&c| c > 0), "'M' must have ink");

        assert_eq!(font.cached_glyphs(), 1);
        font.glyph('M');
        assert_eq!(font.cached_glyphs(), 1, "second lookup must hit the cache");
        font.glyph('W');
        assert_eq!(font.cached_glyphs(), 2);
    }

    #[test]
    fn a_space_has_no_ink() {
        let mut font = font();
        let glyph = font.glyph(' ');
        assert!(glyph.coverage.iter().all(|&c| c == 0));
    }

    #[test]
    fn missing_glyphs_do_not_panic() {
        let mut font = font();
        // Unassigned plane-15 private use codepoint.
        let _ = font.glyph('\u{F0000}');
        let _ = font.glyph('\u{10FFFF}');
    }
}
