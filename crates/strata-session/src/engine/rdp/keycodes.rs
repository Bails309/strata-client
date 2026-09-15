//! X11 keysym to PC scancode translation for RDP input.
//!
//! RDP carries keyboard input as PC/XT "set 1" scancodes plus an
//! extended flag, while the browser sends X11 keysyms. This is the RDP
//! counterpart of [`ssh::keymap`](crate::engine::ssh::keymap), and like
//! it, the mapping is kept pure so it can be tested exhaustively rather
//! than debugged through a live Windows host.
//!
//! Scancodes are the physical key positions of a US layout. The remote
//! host applies its own keyboard layout on top, which is why the same
//! scancode produces a different character on a German target — matching
//! how a real RDP client behaves.

/// A key position on the wire: scancode plus the extended-key flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scancode {
    /// PC/XT set 1 scancode.
    pub code: u8,
    /// Whether the E0 prefix applies.
    pub extended: bool,
}

impl Scancode {
    /// A key on the main block, sent without the `E0` prefix.
    pub const fn plain(code: u8) -> Self {
        Self {
            code,
            extended: false,
        }
    }

    /// A key the `E0` prefix distinguishes from its main-block twin,
    /// such as the numeric keypad's Enter.
    pub const fn extended(code: u8) -> Self {
        Self {
            code,
            extended: true,
        }
    }
}

/// A resolved key event for RDP transmission: either a hardware scancode
/// or a Unicode character fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    /// Physical PC/XT set 1 scancode (for US-layout keys, modifiers, navigation).
    Scancode(Scancode),
    /// Unicode character fallback (for accented/international characters with no physical US key).
    Unicode(char),
}

/// Resolve an X11 keysym to either a physical scancode or a Unicode character fallback.
#[must_use]
pub fn resolve_key(keysym: u32) -> Option<KeyEvent> {
    if let Some(scancode) = keysym_to_scancode(keysym) {
        return Some(KeyEvent::Scancode(scancode));
    }
    crate::engine::keymap::keysym_to_char(keysym).map(KeyEvent::Unicode)
}

/// Translate an X11 keysym to a key position.
///
/// Returns `None` for keysyms with no position on a US keyboard; the
/// caller should drop them rather than guess.
#[must_use]
pub fn keysym_to_scancode(keysym: u32) -> Option<Scancode> {
    if let Some(code) = ascii_scancode(keysym) {
        return Some(code);
    }
    named_scancode(keysym)
}

/// Printable US-layout characters.
///
/// Shifted and unshifted characters share a physical key, so both map to
/// the same scancode — the shift state travels as its own key event.
fn ascii_scancode(keysym: u32) -> Option<Scancode> {
    let code = match u8::try_from(keysym).ok()? {
        b'1' | b'!' => 0x02,
        b'2' | b'@' => 0x03,
        b'3' | b'#' => 0x04,
        b'4' | b'$' => 0x05,
        b'5' | b'%' => 0x06,
        b'6' | b'^' => 0x07,
        b'7' | b'&' => 0x08,
        b'8' | b'*' => 0x09,
        b'9' | b'(' => 0x0a,
        b'0' | b')' => 0x0b,
        b'-' | b'_' => 0x0c,
        b'=' | b'+' => 0x0d,
        b'q' | b'Q' => 0x10,
        b'w' | b'W' => 0x11,
        b'e' | b'E' => 0x12,
        b'r' | b'R' => 0x13,
        b't' | b'T' => 0x14,
        b'y' | b'Y' => 0x15,
        b'u' | b'U' => 0x16,
        b'i' | b'I' => 0x17,
        b'o' | b'O' => 0x18,
        b'p' | b'P' => 0x19,
        b'[' | b'{' => 0x1a,
        b']' | b'}' => 0x1b,
        b'a' | b'A' => 0x1e,
        b's' | b'S' => 0x1f,
        b'd' | b'D' => 0x20,
        b'f' | b'F' => 0x21,
        b'g' | b'G' => 0x22,
        b'h' | b'H' => 0x23,
        b'j' | b'J' => 0x24,
        b'k' | b'K' => 0x25,
        b'l' | b'L' => 0x26,
        b';' | b':' => 0x27,
        b'\'' | b'"' => 0x28,
        b'`' | b'~' => 0x29,
        b'\\' | b'|' => 0x2b,
        b'z' | b'Z' => 0x2c,
        b'x' | b'X' => 0x2d,
        b'c' | b'C' => 0x2e,
        b'v' | b'V' => 0x2f,
        b'b' | b'B' => 0x30,
        b'n' | b'N' => 0x31,
        b'm' | b'M' => 0x32,
        b',' | b'<' => 0x33,
        b'.' | b'>' => 0x34,
        b'/' | b'?' => 0x35,
        b' ' => 0x39,
        _ => return None,
    };
    Some(Scancode::plain(code))
}

/// Keys addressed by their X11 keysym rather than a character.
fn named_scancode(keysym: u32) -> Option<Scancode> {
    let code = match keysym {
        0xff08 => Scancode::plain(0x0e),    // BackSpace
        0xff09 => Scancode::plain(0x0f),    // Tab
        0xff0d => Scancode::plain(0x1c),    // Return
        0xff1b => Scancode::plain(0x01),    // Escape
        0xffe1 => Scancode::plain(0x2a),    // Shift_L
        0xffe2 => Scancode::plain(0x36),    // Shift_R
        0xffe3 => Scancode::plain(0x1d),    // Control_L
        0xffe4 => Scancode::extended(0x1d), // Control_R
        0xffe9 => Scancode::plain(0x38),    // Alt_L
        0xffea => Scancode::extended(0x38), // Alt_R / AltGr
        0xffe5 => Scancode::plain(0x3a),    // Caps_Lock
        0xff7f => Scancode::plain(0x45),    // Num_Lock
        0xff14 => Scancode::plain(0x46),    // Scroll_Lock
        0xffeb => Scancode::extended(0x5b), // Super_L (left Windows key)
        0xffec => Scancode::extended(0x5c), // Super_R
        0xff67 => Scancode::extended(0x5d), // Menu
        0xff50 => Scancode::extended(0x47), // Home
        0xff51 => Scancode::extended(0x4b), // Left
        0xff52 => Scancode::extended(0x48), // Up
        0xff53 => Scancode::extended(0x4d), // Right
        0xff54 => Scancode::extended(0x50), // Down
        0xff55 => Scancode::extended(0x49), // Page_Up
        0xff56 => Scancode::extended(0x51), // Page_Down
        0xff57 => Scancode::extended(0x4f), // End
        0xff63 => Scancode::extended(0x52), // Insert
        0xffff => Scancode::extended(0x53), // Delete
        0xffbe => Scancode::plain(0x3b),    // F1
        0xffbf => Scancode::plain(0x3c),    // F2
        0xffc0 => Scancode::plain(0x3d),    // F3
        0xffc1 => Scancode::plain(0x3e),    // F4
        0xffc2 => Scancode::plain(0x3f),    // F5
        0xffc3 => Scancode::plain(0x40),    // F6
        0xffc4 => Scancode::plain(0x41),    // F7
        0xffc5 => Scancode::plain(0x42),    // F8
        0xffc6 => Scancode::plain(0x43),    // F9
        0xffc7 => Scancode::plain(0x44),    // F10
        0xffc8 => Scancode::plain(0x57),    // F11
        0xffc9 => Scancode::plain(0x58),    // F12
        0xffaf => Scancode::plain(0x35),    // KP_Divide -> shares the '/' key
        0xffaa => Scancode::plain(0x37),    // KP_Multiply
        0xffad => Scancode::plain(0x4a),    // KP_Subtract
        0xffab => Scancode::plain(0x4e),    // KP_Add
        0xff8d => Scancode::extended(0x1c), // KP_Enter
        _ => return None,
    };
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_map_to_their_us_layout_positions() {
        // 'a' sits at 0x1e on a US keyboard, not at its alphabetical index.
        assert_eq!(
            keysym_to_scancode(u32::from(b'a')),
            Some(Scancode::plain(0x1e))
        );
        assert_eq!(
            keysym_to_scancode(u32::from(b'q')),
            Some(Scancode::plain(0x10))
        );
        assert_eq!(
            keysym_to_scancode(u32::from(b'z')),
            Some(Scancode::plain(0x2c))
        );
    }

    #[test]
    fn shifted_characters_share_the_unshifted_key() {
        // The remote host derives the character from scancode + shift
        // state, so both must resolve to one physical key.
        for (lower, upper) in [
            (b'a', b'A'),
            (b'1', b'!'),
            (b'/', b'?'),
            (b';', b':'),
            (b'[', b'{'),
        ] {
            assert_eq!(
                keysym_to_scancode(u32::from(lower)),
                keysym_to_scancode(u32::from(upper)),
                "{} and {} must share a key",
                lower as char,
                upper as char
            );
        }
    }

    #[test]
    fn navigation_keys_are_flagged_extended() {
        // Arrows and the navigation cluster live on the E0 prefix; a
        // missing flag turns Left into keypad-4 on the remote host.
        for keysym in [0xff51, 0xff52, 0xff53, 0xff54, 0xff50, 0xff57, 0xffff] {
            let code = keysym_to_scancode(keysym).unwrap();
            assert!(code.extended, "keysym {keysym:#x} must be extended");
        }
    }

    #[test]
    fn left_and_right_modifiers_are_distinguishable() {
        // AltGr is right-Alt with the extended flag; conflating it with
        // left-Alt breaks every non-US layout.
        let alt_l = keysym_to_scancode(0xffe9).unwrap();
        let alt_r = keysym_to_scancode(0xffea).unwrap();
        assert_eq!(alt_l.code, alt_r.code);
        assert!(!alt_l.extended && alt_r.extended);

        let ctrl_l = keysym_to_scancode(0xffe3).unwrap();
        let ctrl_r = keysym_to_scancode(0xffe4).unwrap();
        assert_eq!(ctrl_l.code, ctrl_r.code);
        assert!(!ctrl_l.extended && ctrl_r.extended);

        // Shift is the exception: genuinely different scancodes.
        assert_ne!(
            keysym_to_scancode(0xffe1).unwrap().code,
            keysym_to_scancode(0xffe2).unwrap().code
        );
    }

    #[test]
    fn function_keys_are_contiguous_then_jump() {
        // F1-F10 are 0x3b..0x44, but F11/F12 are 0x57/0x58 — the gap is
        // real and a naive f(n) = 0x3a + n mapping gets it wrong.
        assert_eq!(keysym_to_scancode(0xffbe).unwrap().code, 0x3b);
        assert_eq!(keysym_to_scancode(0xffc7).unwrap().code, 0x44);
        assert_eq!(keysym_to_scancode(0xffc8).unwrap().code, 0x57);
        assert_eq!(keysym_to_scancode(0xffc9).unwrap().code, 0x58);
    }

    #[test]
    fn the_windows_key_is_extended() {
        assert_eq!(keysym_to_scancode(0xffeb), Some(Scancode::extended(0x5b)));
    }

    #[test]
    fn unmapped_keysyms_are_dropped_rather_than_guessed() {
        // Unicode keysyms have no US-layout position.
        assert_eq!(keysym_to_scancode(0x0100_20ac), None);
        assert_eq!(keysym_to_scancode(0xff20), None);
    }

    #[test]
    fn resolve_key_distinguishes_scancodes_and_unicode_fallback() {
        // Standard keys map to scancodes
        assert_eq!(
            resolve_key(u32::from(b'a')),
            Some(KeyEvent::Scancode(Scancode::plain(0x1e)))
        );
        assert_eq!(
            resolve_key(0xff08), // BackSpace
            Some(KeyEvent::Scancode(Scancode::plain(0x0e)))
        );

        // International characters fall back to Unicode
        assert_eq!(resolve_key(0x00e9), Some(KeyEvent::Unicode('é')));
        assert_eq!(resolve_key(0x00fc), Some(KeyEvent::Unicode('ü')));
        assert_eq!(resolve_key(0x00f1), Some(KeyEvent::Unicode('ñ')));
        assert_eq!(resolve_key(0x0100_20ac), Some(KeyEvent::Unicode('€')));
        assert_eq!(resolve_key(0x0100_4e2d), Some(KeyEvent::Unicode('中')));

        // Unmapped non-character keysyms return None
        assert_eq!(resolve_key(0xff20), None);
        assert_eq!(resolve_key(0x0200_0000), None);
    }

    #[test]
    fn never_panics_across_the_keysym_space() {
        for keysym in (0u32..0x0110_0000).step_by(89) {
            let _ = keysym_to_scancode(keysym);
            let _ = resolve_key(keysym);
        }
    }
}
