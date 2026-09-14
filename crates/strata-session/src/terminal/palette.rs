//! ANSI colour resolution.
//!
//! Terminal cells carry colours as one of three things: a named ANSI
//! colour, an index into the 256-colour cube, or a literal RGB triple.
//! Rendering needs concrete pixels, so this module owns the mapping.
//!
//! The 16 base colours use xterm's values rather than the VGA ones, so
//! output matches what a user sees in any other terminal.

use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

/// A resolved 8-bit-per-channel colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pixel {
    /// Red channel.
    pub r: u8,
    /// Green channel.
    pub g: u8,
    /// Blue channel.
    pub b: u8,
}

impl Pixel {
    /// Construct a colour.
    #[must_use]
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    /// Scale every channel, used for the ANSI "dim" attribute.
    #[must_use]
    pub fn dim(self) -> Self {
        Self {
            r: (u16::from(self.r) * 2 / 3) as u8,
            g: (u16::from(self.g) * 2 / 3) as u8,
            b: (u16::from(self.b) * 2 / 3) as u8,
        }
    }
}

impl From<Rgb> for Pixel {
    fn from(rgb: Rgb) -> Self {
        Self::new(rgb.r, rgb.g, rgb.b)
    }
}

/// The 16 base ANSI colours, in xterm's rendition.
const ANSI16: [Pixel; 16] = [
    Pixel::new(0, 0, 0),
    Pixel::new(205, 0, 0),
    Pixel::new(0, 205, 0),
    Pixel::new(205, 205, 0),
    Pixel::new(0, 0, 238),
    Pixel::new(205, 0, 205),
    Pixel::new(0, 205, 205),
    Pixel::new(229, 229, 229),
    Pixel::new(127, 127, 127),
    Pixel::new(255, 0, 0),
    Pixel::new(0, 255, 0),
    Pixel::new(255, 255, 0),
    Pixel::new(92, 92, 255),
    Pixel::new(255, 0, 255),
    Pixel::new(0, 255, 255),
    Pixel::new(255, 255, 255),
];

/// Channel values used by the 6x6x6 colour cube.
const CUBE_STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];

/// Colour scheme for one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    /// Default text colour.
    pub foreground: Pixel,
    /// Default background colour.
    pub background: Pixel,
    /// Colour of the cursor block.
    pub cursor: Pixel,
}

impl Default for Palette {
    fn default() -> Self {
        Self {
            foreground: Pixel::new(229, 229, 229),
            background: Pixel::new(0, 0, 0),
            cursor: Pixel::new(229, 229, 229),
        }
    }
}

impl Palette {
    /// Build a palette from guacd's `color-scheme` parameter.
    ///
    /// The four schemes guacd defines, named the same way, so a
    /// connection configured for either engine renders the same.
    /// Unrecognised values return `None` rather than a guess.
    #[must_use]
    pub fn from_scheme(scheme: &str) -> Option<Self> {
        let (fg, bg) = match scheme.trim().to_ascii_lowercase().as_str() {
            "black-white" => (Pixel::new(0, 0, 0), Pixel::new(255, 255, 255)),
            "white-black" => (Pixel::new(255, 255, 255), Pixel::new(0, 0, 0)),
            "gray-black" | "grey-black" => (Pixel::new(170, 170, 170), Pixel::new(0, 0, 0)),
            "green-black" => (Pixel::new(0, 255, 0), Pixel::new(0, 0, 0)),
            _ => return None,
        };
        Some(Self {
            foreground: fg,
            background: bg,
            // Matching the text keeps the block readable whatever the
            // scheme inverts.
            cursor: fg,
        })
    }

    /// Resolve a cell colour to pixels.
    #[must_use]
    pub fn resolve(&self, color: Color) -> Pixel {
        match color {
            Color::Spec(rgb) => rgb.into(),
            Color::Indexed(index) => self.indexed(index),
            Color::Named(named) => self.named(named),
        }
    }

    /// Resolve an index into the 256-colour palette.
    #[must_use]
    pub fn indexed(&self, index: u8) -> Pixel {
        match index {
            0..=15 => ANSI16[index as usize],
            // 6x6x6 colour cube.
            16..=231 => {
                let i = index - 16;
                Pixel::new(
                    CUBE_STEPS[(i / 36) as usize],
                    CUBE_STEPS[((i % 36) / 6) as usize],
                    CUBE_STEPS[(i % 6) as usize],
                )
            }
            // 24-step greyscale ramp.
            232..=255 => {
                let level = 8 + (index - 232) * 10;
                Pixel::new(level, level, level)
            }
        }
    }

    fn named(&self, named: NamedColor) -> Pixel {
        match named {
            NamedColor::Black => ANSI16[0],
            NamedColor::Red => ANSI16[1],
            NamedColor::Green => ANSI16[2],
            NamedColor::Yellow => ANSI16[3],
            NamedColor::Blue => ANSI16[4],
            NamedColor::Magenta => ANSI16[5],
            NamedColor::Cyan => ANSI16[6],
            NamedColor::White => ANSI16[7],
            NamedColor::BrightBlack => ANSI16[8],
            NamedColor::BrightRed => ANSI16[9],
            NamedColor::BrightGreen => ANSI16[10],
            NamedColor::BrightYellow => ANSI16[11],
            NamedColor::BrightBlue => ANSI16[12],
            NamedColor::BrightMagenta => ANSI16[13],
            NamedColor::BrightCyan => ANSI16[14],
            NamedColor::BrightWhite => ANSI16[15],
            NamedColor::DimBlack => ANSI16[0].dim(),
            NamedColor::DimRed => ANSI16[1].dim(),
            NamedColor::DimGreen => ANSI16[2].dim(),
            NamedColor::DimYellow => ANSI16[3].dim(),
            NamedColor::DimBlue => ANSI16[4].dim(),
            NamedColor::DimMagenta => ANSI16[5].dim(),
            NamedColor::DimCyan => ANSI16[6].dim(),
            NamedColor::DimWhite => ANSI16[7].dim(),
            NamedColor::Foreground | NamedColor::BrightForeground => self.foreground,
            NamedColor::DimForeground => self.foreground.dim(),
            NamedColor::Background => self.background,
            NamedColor::Cursor => self.cursor,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_colours_pass_through() {
        let palette = Palette::default();
        let resolved = palette.resolve(Color::Spec(Rgb { r: 1, g: 2, b: 3 }));
        assert_eq!(resolved, Pixel::new(1, 2, 3));
    }

    #[test]
    fn the_first_sixteen_indices_are_the_ansi_colours() {
        let palette = Palette::default();
        assert_eq!(palette.indexed(0), Pixel::new(0, 0, 0));
        assert_eq!(palette.indexed(1), Pixel::new(205, 0, 0));
        assert_eq!(palette.indexed(15), Pixel::new(255, 255, 255));
        assert_eq!(
            palette.resolve(Color::Named(NamedColor::Red)),
            palette.indexed(1)
        );
    }

    #[test]
    fn the_colour_cube_matches_xterm() {
        let palette = Palette::default();
        // 16 is the cube's origin, 231 its opposite corner.
        assert_eq!(palette.indexed(16), Pixel::new(0, 0, 0));
        assert_eq!(palette.indexed(231), Pixel::new(255, 255, 255));
        // 196 is pure red in the cube: (5, 0, 0).
        assert_eq!(palette.indexed(196), Pixel::new(255, 0, 0));
        // 46 is pure green: (0, 5, 0).
        assert_eq!(palette.indexed(46), Pixel::new(0, 255, 0));
        // 21 is pure blue: (0, 0, 5).
        assert_eq!(palette.indexed(21), Pixel::new(0, 0, 255));
    }

    #[test]
    fn the_greyscale_ramp_is_monotonic() {
        let palette = Palette::default();
        assert_eq!(palette.indexed(232), Pixel::new(8, 8, 8));
        assert_eq!(palette.indexed(255), Pixel::new(238, 238, 238));
        for index in 232..255u8 {
            assert!(palette.indexed(index).r < palette.indexed(index + 1).r);
        }
    }

    #[test]
    fn every_index_resolves_without_panicking() {
        let palette = Palette::default();
        for index in 0..=255u8 {
            let _ = palette.indexed(index);
        }
    }

    #[test]
    fn default_colours_follow_the_palette_not_the_ansi_table() {
        let palette = Palette {
            foreground: Pixel::new(10, 20, 30),
            background: Pixel::new(40, 50, 60),
            cursor: Pixel::new(70, 80, 90),
        };
        assert_eq!(
            palette.resolve(Color::Named(NamedColor::Foreground)),
            Pixel::new(10, 20, 30)
        );
        assert_eq!(
            palette.resolve(Color::Named(NamedColor::Background)),
            Pixel::new(40, 50, 60)
        );
        assert_eq!(
            palette.resolve(Color::Named(NamedColor::Cursor)),
            Pixel::new(70, 80, 90)
        );
    }

    #[test]
    fn dim_darkens_without_underflowing() {
        assert_eq!(Pixel::new(255, 255, 255).dim(), Pixel::new(170, 170, 170));
        assert_eq!(Pixel::new(0, 0, 0).dim(), Pixel::new(0, 0, 0));
    }
}
