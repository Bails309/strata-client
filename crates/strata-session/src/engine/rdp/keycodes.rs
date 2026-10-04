//! X11 keysym to PC scancode translation for RDP input.
//!
//! RDP carries keyboard input as PC/XT "set 1" scancodes plus an
//! extended flag, while the browser sends X11 keysyms. This is the RDP
//! counterpart of [`ssh::keymap`](crate::engine::ssh::keymap), and like
//! it, the mapping is kept pure so it can be tested exhaustively rather
//! than debugged through a live Windows host.
//!
//! Named keys (modifiers, navigation, function keys, keypad) are fixed
//! positions. Printable characters are typed through the target layout's
//! [`Keymap`]: the browser reports the character the user's own layout
//! produced, so it has to be re-typed on the target's layout rather than
//! sent as the US key position. Unicode events are the fallback for
//! characters the layout cannot type -- not the default, because console
//! line editors (PSReadLine on Server Core) drop them.

use super::layouts::{KeyStroke, Keymap};

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

/// A resolved key event for RDP transmission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    /// A key position, sent with whatever modifiers are already held.
    Scancode(Scancode),
    /// A character on the target layout, with the modifiers that type it.
    Character(KeyStroke),
    /// Unicode character fallback, for characters the layout cannot type.
    Unicode(char),
}

/// Resolve an X11 keysym for transmission.
///
/// With a `keymap`, printable characters are typed on the target's layout.
/// Without one (guacd's `failsafe` layout) they travel as Unicode.
///
/// `shortcut_held` forces a bare key position: `Ctrl+C` has to arrive as a
/// key, because a Unicode `c` is text rather than a shortcut, and the user's
/// own modifiers must not be adjusted underneath it.
#[must_use]
pub fn resolve_key(keysym: u32, shortcut_held: bool, keymap: Option<&Keymap>) -> Option<KeyEvent> {
    if let Some(stroke) = keymap.and_then(|keymap| keymap.stroke(keysym)) {
        return Some(if shortcut_held {
            KeyEvent::Scancode(stroke.scancode)
        } else {
            KeyEvent::Character(stroke)
        });
    }
    if !shortcut_held {
        if let Some(ch) = crate::engine::keymap::keysym_to_char(keysym) {
            // Space keeps its key position: it is identical on every layout
            // and is read as a key, not text, by games and terminal UIs.
            if !ch.is_control() && ch != ' ' {
                return Some(KeyEvent::Unicode(ch));
            }
        }
    }
    if let Some(scancode) = keysym_to_scancode(keysym) {
        return Some(KeyEvent::Scancode(scancode));
    }
    crate::engine::keymap::keysym_to_char(keysym).map(KeyEvent::Unicode)
}

/// Lock keys the browser has already applied to the keysyms it sends.
///
/// Forwarding them would toggle the target's state a second time, and the
/// engine needs Caps Lock off and Num Lock on for its scancodes to mean
/// what it intends.
#[must_use]
pub fn is_local_lock_key(keysym: u32) -> bool {
    matches!(keysym, 0xffe5 | 0xff7f) // Caps_Lock, Num_Lock
}

/// Keypad keys whose scancode only types a digit with Num Lock on.
#[must_use]
pub fn needs_num_lock(keysym: u32) -> bool {
    matches!(keysym, 0xffb0..=0xffb9 | 0xffae | 0xffac)
}

/// The bit a modifier keysym occupies in the held-shortcut set.
///
/// `Alt_R` is deliberately absent: on most non-US layouts it is AltGr, a
/// character compositor rather than a shortcut modifier, and treating it as
/// one would send `AltGr+Q` on a German keyboard as a US key position.
#[must_use]
pub fn shortcut_modifier_bit(keysym: u32) -> Option<u8> {
    match keysym {
        0xffe3 => Some(1 << 0), // Control_L
        0xffe4 => Some(1 << 1), // Control_R
        0xffe9 => Some(1 << 2), // Alt_L
        0xffeb => Some(1 << 3), // Super_L
        0xffec => Some(1 << 4), // Super_R
        _ => None,
    }
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
        0xffaf => Scancode::extended(0x35), // KP_Divide
        0xffaa => Scancode::plain(0x37),    // KP_Multiply
        0xffad => Scancode::plain(0x4a),    // KP_Subtract
        0xffab => Scancode::plain(0x4e),    // KP_Add
        0xff8d => Scancode::extended(0x1c), // KP_Enter
        0xffb0 => Scancode::plain(0x52),    // KP_0
        0xffb1 => Scancode::plain(0x4f),    // KP_1
        0xffb2 => Scancode::plain(0x50),    // KP_2
        0xffb3 => Scancode::plain(0x51),    // KP_3
        0xffb4 => Scancode::plain(0x4b),    // KP_4
        0xffb5 => Scancode::plain(0x4c),    // KP_5
        0xffb6 => Scancode::plain(0x4d),    // KP_6
        0xffb7 => Scancode::plain(0x47),    // KP_7
        0xffb8 => Scancode::plain(0x48),    // KP_8
        0xffb9 => Scancode::plain(0x49),    // KP_9
        0xffae => Scancode::plain(0x53),    // KP_Decimal
        0xffac => Scancode::plain(0x53),    // KP_Separator (decimal comma)
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

    fn uk() -> Option<&'static Keymap> {
        super::super::layouts::keymap_for_layout(0x0809)
    }

    fn stroke(code: u8, shift: bool, altgr: bool) -> Option<KeyEvent> {
        Some(KeyEvent::Character(KeyStroke {
            scancode: Scancode::plain(code),
            shift,
            altgr,
        }))
    }

    #[test]
    fn printable_characters_are_typed_on_the_target_layout() {
        // #420: a UK `\` sent as the US position 0x2b reads as `#` on a UK
        // target, so the UK table's own positions are used.
        assert_eq!(
            resolve_key(u32::from(b'\\'), false, uk()),
            stroke(0x56, false, false)
        );
        assert_eq!(
            resolve_key(u32::from(b'#'), false, uk()),
            stroke(0x2b, false, false)
        );
        assert_eq!(
            resolve_key(u32::from(b'@'), false, uk()),
            stroke(0x28, true, false)
        );
        assert_eq!(resolve_key(0x00a3, false, uk()), stroke(0x04, true, false)); // £
                                                                                 // Not Unicode: PSReadLine on Server Core drops VK_PACKET input.
        assert_eq!(
            resolve_key(u32::from(b'a'), false, uk()),
            stroke(0x1e, false, false)
        );
        assert_eq!(
            resolve_key(u32::from(b'-'), false, uk()),
            stroke(0x0c, false, false)
        );
    }

    #[test]
    fn characters_the_layout_cannot_type_fall_back_to_unicode() {
        assert_eq!(
            resolve_key(0x00fc, false, uk()),
            Some(KeyEvent::Unicode('ü'))
        );
        assert_eq!(
            resolve_key(0x0100_4e2d, false, uk()),
            Some(KeyEvent::Unicode('中'))
        );
    }

    #[test]
    fn without_a_keymap_printable_characters_travel_as_unicode() {
        // guacd's `failsafe` layout.
        assert_eq!(
            resolve_key(u32::from(b'\\'), false, None),
            Some(KeyEvent::Unicode('\\'))
        );
        assert_eq!(
            resolve_key(0x00a3, false, None),
            Some(KeyEvent::Unicode('£'))
        );
    }

    #[test]
    fn a_held_shortcut_modifier_sends_a_bare_key_position() {
        // Ctrl+C must arrive as a key position: a Unicode `c` is text.
        assert_eq!(
            resolve_key(u32::from(b'c'), true, uk()),
            Some(KeyEvent::Scancode(Scancode::plain(0x2e)))
        );
        assert_eq!(
            resolve_key(u32::from(b'c'), true, None),
            Some(KeyEvent::Scancode(Scancode::plain(0x2e)))
        );
        // AZERTY: Ctrl+A is the key labelled A, which is the US Q position.
        let fr = super::super::layouts::keymap_for_layout(0x040c);
        assert_eq!(
            resolve_key(u32::from(b'a'), true, fr),
            Some(KeyEvent::Scancode(Scancode::plain(0x10)))
        );
    }

    #[test]
    fn space_keeps_its_key_position() {
        // Identical on every layout, and read as a key rather than text by
        // games and full-screen terminal UIs.
        for keymap in [uk(), None] {
            assert_eq!(
                resolve_key(u32::from(b' '), false, keymap),
                Some(KeyEvent::Scancode(Scancode::plain(0x39)))
            );
        }
    }

    #[test]
    fn keypad_digits_use_keypad_positions() {
        // The keypad, not the top row: Alt+numpad codes depend on it.
        assert_eq!(
            resolve_key(0xffb1, false, uk()),
            Some(KeyEvent::Scancode(Scancode::plain(0x4f)))
        );
        assert_eq!(
            resolve_key(0xffb0, false, None),
            Some(KeyEvent::Scancode(Scancode::plain(0x52)))
        );
        assert_eq!(
            resolve_key(0xffae, false, uk()),
            Some(KeyEvent::Scancode(Scancode::plain(0x53)))
        );
        // Keypad `/` is E0-prefixed; without it the target reads the main `/`.
        assert_eq!(keysym_to_scancode(0xffaf), Some(Scancode::extended(0x35)));
        for keysym in 0xffb0..=0xffb9 {
            assert!(needs_num_lock(keysym));
        }
        assert!(!needs_num_lock(0xffab)); // KP_Add works either way
    }

    #[test]
    fn lock_keys_are_applied_locally() {
        assert!(is_local_lock_key(0xffe5)); // Caps_Lock
        assert!(is_local_lock_key(0xff7f)); // Num_Lock
        assert!(!is_local_lock_key(0xff14)); // Scroll_Lock is a real key
    }

    #[test]
    fn altgr_is_not_treated_as_a_shortcut_modifier() {
        // Alt_R composes characters on most non-US layouts, so counting it
        // would send AltGr+Q on a German keyboard as a US key position.
        assert_eq!(shortcut_modifier_bit(0xffea), None); // Alt_R
        assert!(shortcut_modifier_bit(0xffe9).is_some()); // Alt_L
        assert!(shortcut_modifier_bit(0xffe3).is_some()); // Control_L
        assert!(shortcut_modifier_bit(0xffe4).is_some()); // Control_R
                                                          // Each modifier owns a distinct bit, so releasing one does not
                                                          // clear another.
        assert_ne!(shortcut_modifier_bit(0xffe3), shortcut_modifier_bit(0xffe4));
        assert_eq!(shortcut_modifier_bit(u32::from(b'a')), None);
    }

    #[test]
    fn resolve_key_distinguishes_scancodes_and_unicode_fallback() {
        assert_eq!(
            resolve_key(0xff08, false, uk()), // BackSpace
            Some(KeyEvent::Scancode(Scancode::plain(0x0e)))
        );
        assert_eq!(
            resolve_key(0x00f1, true, uk()),
            Some(KeyEvent::Unicode('ñ'))
        );
        assert_eq!(
            resolve_key(0x00e9, false, None),
            Some(KeyEvent::Unicode('é'))
        );

        // Unmapped non-character keysyms return None
        assert_eq!(resolve_key(0xff20, false, uk()), None);
        assert_eq!(resolve_key(0x0200_0000, false, None), None);
    }

    #[test]
    fn never_panics_across_the_keysym_space() {
        for keysym in (0u32..0x0110_0000).step_by(89) {
            let _ = keysym_to_scancode(keysym);
            for keymap in [uk(), None] {
                let _ = resolve_key(keysym, false, keymap);
                let _ = resolve_key(keysym, true, keymap);
            }
        }
    }
}
