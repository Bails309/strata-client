//! X11 keysym to terminal byte-sequence translation.
//!
//! The browser sends `key` instructions carrying X11 keysyms, because
//! that is what the Guacamole protocol speaks. A PTY wants bytes. This
//! module is the bridge, and it is the part of a terminal engine most
//! likely to be subtly wrong, so it is kept pure and tested exhaustively
//! rather than buried in the connection code.
//!
//! Shared by every PTY-backed engine rather than owned by SSH: nothing
//! here is protocol-specific, and a Kubernetes exec session needs
//! exactly the same translation.
//!
//! Sequences follow xterm's default behaviour, which is what `TERM=xterm-256color`
//! promises the remote shell.

/// Character cell dimensions, used to convert the client's pixel
/// geometry into the rows and columns a PTY wants.
#[derive(Debug, Clone, Copy)]
pub struct CellSize {
    /// Cell width in pixels.
    pub width: u32,
    /// Cell height in pixels.
    pub height: u32,
}

impl Default for CellSize {
    fn default() -> Self {
        Self {
            width: 8,
            height: 16,
        }
    }
}

impl CellSize {
    /// Convert a pixel geometry to `(columns, rows)`, never returning
    /// zero in either axis.
    #[must_use]
    pub fn to_grid(self, width_px: u32, height_px: u32) -> (u32, u32) {
        let cols = width_px / self.width.max(1);
        let rows = height_px / self.height.max(1);
        (cols.max(1), rows.max(1))
    }
}

/// Modifier keys held down.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Modifiers {
    /// Either Control key.
    pub ctrl: bool,
    /// Either Alt / Meta key.
    pub alt: bool,
    /// Either Shift key.
    pub shift: bool,
}

impl Modifiers {
    /// Update state from a key event.
    ///
    /// Returns `true` when `keysym` was a modifier and therefore
    /// produces no output of its own.
    pub fn track(&mut self, keysym: u32, pressed: bool) -> bool {
        match keysym {
            0xffe1 | 0xffe2 => self.shift = pressed,
            0xffe3 | 0xffe4 => self.ctrl = pressed,
            // Meta_L, Meta_R, Alt_L, Alt_R.
            0xffe7..=0xffea => self.alt = pressed,
            _ => return false,
        }
        true
    }
}

/// Translate a key press into the bytes a PTY expects.
///
/// Returns `None` for keys with no terminal representation (modifiers,
/// unmapped function keys), which the caller should simply drop.
#[must_use]
pub fn keysym_to_bytes(keysym: u32, mods: Modifiers) -> Option<Vec<u8>> {
    let mut out = named_key(keysym).or_else(|| printable(keysym, mods))?;

    // Alt is transmitted as an ESC prefix ("meta sends escape"), which
    // is what readline and every TUI expects.
    if mods.alt {
        out.insert(0, 0x1b);
    }
    Some(out)
}

/// Keys with a fixed escape sequence, independent of modifiers.
fn named_key(keysym: u32) -> Option<Vec<u8>> {
    let bytes: &[u8] = match keysym {
        0xff08 => &[0x7f],     // BackSpace -> DEL, as xterm sends
        0xff09 => &[0x09],     // Tab
        0xff0d => &[0x0d],     // Return
        0xff1b => &[0x1b],     // Escape
        0xff50 => b"\x1b[H",   // Home
        0xff51 => b"\x1b[D",   // Left
        0xff52 => b"\x1b[A",   // Up
        0xff53 => b"\x1b[C",   // Right
        0xff54 => b"\x1b[B",   // Down
        0xff55 => b"\x1b[5~",  // Page_Up
        0xff56 => b"\x1b[6~",  // Page_Down
        0xff57 => b"\x1b[F",   // End
        0xff63 => b"\x1b[2~",  // Insert
        0xffff => b"\x1b[3~",  // Delete
        0xffbe => b"\x1bOP",   // F1
        0xffbf => b"\x1bOQ",   // F2
        0xffc0 => b"\x1bOR",   // F3
        0xffc1 => b"\x1bOS",   // F4
        0xffc2 => b"\x1b[15~", // F5
        0xffc3 => b"\x1b[17~", // F6
        0xffc4 => b"\x1b[18~", // F7
        0xffc5 => b"\x1b[19~", // F8
        0xffc6 => b"\x1b[20~", // F9
        0xffc7 => b"\x1b[21~", // F10
        0xffc8 => b"\x1b[23~", // F11
        0xffc9 => b"\x1b[24~", // F12
        // Keypad Enter behaves as Return in the common (numeric) mode.
        0xff8d => &[0x0d],
        _ => return None,
    };
    Some(bytes.to_vec())
}

/// Printable characters, including their Control-modified forms.
fn printable(keysym: u32, mods: Modifiers) -> Option<Vec<u8>> {
    let ch = keysym_to_char(keysym)?;

    if mods.ctrl {
        return control_char(ch).map(|b| vec![b]);
    }

    let mut buf = [0u8; 4];
    Some(ch.encode_utf8(&mut buf).as_bytes().to_vec())
}

/// Map a keysym to the character it represents.
///
/// Latin-1 keysyms are their own codepoint; everything else arrives as
/// a Unicode keysym with the `0x01000000` flag set.
fn keysym_to_char(keysym: u32) -> Option<char> {
    match keysym {
        0x20..=0xff => char::from_u32(keysym),
        0x0100_0000..=0x0110_ffff => char::from_u32(keysym - 0x0100_0000),
        _ => None,
    }
}

/// The control character produced by Ctrl plus `ch`.
fn control_char(ch: char) -> Option<u8> {
    match ch {
        // Ctrl+A..Ctrl+Z, case-insensitively.
        'a'..='z' => Some(ch as u8 - b'a' + 1),
        'A'..='Z' => Some(ch as u8 - b'A' + 1),
        // The classic non-alphabetic control codes.
        '@' | ' ' => Some(0x00),
        '[' => Some(0x1b),
        '\\' => Some(0x1c),
        ']' => Some(0x1d),
        '^' => Some(0x1e),
        '_' | '?' => Some(0x1f),
        // Ctrl with anything else is passed through unmodified, which is
        // what xterm does.
        _ => {
            let mut buf = [0u8; 4];
            let encoded = ch.encode_utf8(&mut buf);
            encoded.as_bytes().first().copied()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(keysym: u32) -> Option<Vec<u8>> {
        keysym_to_bytes(keysym, Modifiers::default())
    }

    #[test]
    fn ascii_keysyms_are_their_own_bytes() {
        assert_eq!(plain(u32::from(b'a')).unwrap(), b"a");
        assert_eq!(plain(u32::from(b'Z')).unwrap(), b"Z");
        assert_eq!(plain(u32::from(b' ')).unwrap(), b" ");
        assert_eq!(plain(u32::from(b'~')).unwrap(), b"~");
    }

    #[test]
    fn control_keys_use_the_sequences_xterm_promises() {
        assert_eq!(plain(0xff0d).unwrap(), b"\r");
        assert_eq!(plain(0xff09).unwrap(), b"\t");
        assert_eq!(plain(0xff1b).unwrap(), b"\x1b");
        // Backspace must be DEL, not BS: sending 0x08 breaks readline
        // editing on essentially every modern Linux target.
        assert_eq!(plain(0xff08).unwrap(), b"\x7f");
    }

    #[test]
    fn arrow_and_navigation_keys_are_mapped() {
        assert_eq!(plain(0xff52).unwrap(), b"\x1b[A");
        assert_eq!(plain(0xff54).unwrap(), b"\x1b[B");
        assert_eq!(plain(0xff53).unwrap(), b"\x1b[C");
        assert_eq!(plain(0xff51).unwrap(), b"\x1b[D");
        assert_eq!(plain(0xff50).unwrap(), b"\x1b[H");
        assert_eq!(plain(0xff57).unwrap(), b"\x1b[F");
        assert_eq!(plain(0xffff).unwrap(), b"\x1b[3~");
    }

    #[test]
    fn function_keys_are_mapped() {
        assert_eq!(plain(0xffbe).unwrap(), b"\x1bOP");
        assert_eq!(plain(0xffc1).unwrap(), b"\x1bOS");
        assert_eq!(plain(0xffc2).unwrap(), b"\x1b[15~");
        assert_eq!(plain(0xffc9).unwrap(), b"\x1b[24~");
    }

    #[test]
    fn ctrl_produces_control_codes() {
        let ctrl = Modifiers {
            ctrl: true,
            ..Modifiers::default()
        };
        assert_eq!(keysym_to_bytes(u32::from(b'c'), ctrl).unwrap(), &[0x03]);
        assert_eq!(keysym_to_bytes(u32::from(b'C'), ctrl).unwrap(), &[0x03]);
        assert_eq!(keysym_to_bytes(u32::from(b'd'), ctrl).unwrap(), &[0x04]);
        assert_eq!(keysym_to_bytes(u32::from(b'['), ctrl).unwrap(), &[0x1b]);
        assert_eq!(keysym_to_bytes(u32::from(b' '), ctrl).unwrap(), &[0x00]);
    }

    #[test]
    fn alt_prefixes_with_escape() {
        let alt = Modifiers {
            alt: true,
            ..Modifiers::default()
        };
        assert_eq!(keysym_to_bytes(u32::from(b'b'), alt).unwrap(), b"\x1bb");
        // Alt applies to escape sequences too.
        assert_eq!(keysym_to_bytes(0xff52, alt).unwrap(), b"\x1b\x1b[A");
    }

    #[test]
    fn unicode_keysyms_are_utf8_encoded() {
        // Guacamole sends non-Latin-1 characters as 0x01000000 | codepoint.
        assert_eq!(plain(0x0100_20ac).unwrap(), "€".as_bytes());
        assert_eq!(plain(0x0100_4e2d).unwrap(), "中".as_bytes());
        // Latin-1 keysyms are their own codepoint.
        assert_eq!(plain(0xe9).unwrap(), "é".as_bytes());
    }

    #[test]
    fn modifier_keys_produce_no_output() {
        for keysym in [0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe9, 0xffea] {
            assert_eq!(plain(keysym), None, "keysym {keysym:#x} should be silent");
        }
    }

    #[test]
    fn modifier_state_tracks_press_and_release() {
        let mut mods = Modifiers::default();
        assert!(mods.track(0xffe3, true));
        assert!(mods.ctrl);
        assert!(mods.track(0xffe3, false));
        assert!(!mods.ctrl);
        // A non-modifier keysym leaves state alone and is not consumed.
        assert!(!mods.track(u32::from(b'a'), true));
    }

    #[test]
    fn unmapped_keysyms_are_dropped_rather_than_guessed() {
        // Caps_Lock, Num_Lock, Super_L: real keys with no PTY meaning.
        for keysym in [0xffe5, 0xff7f, 0xffeb] {
            assert_eq!(plain(keysym), None);
        }
    }

    #[test]
    fn never_panics_across_the_keysym_space() {
        let mods = Modifiers {
            ctrl: true,
            alt: true,
            shift: true,
        };
        for keysym in (0u32..0x0110_0000).step_by(97) {
            let _ = keysym_to_bytes(keysym, mods);
            let _ = keysym_to_bytes(keysym, Modifiers::default());
        }
    }
}
