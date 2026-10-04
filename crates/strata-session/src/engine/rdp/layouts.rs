//! Keyboard layouts: guacd `server-layout` names, Windows layout ids, and
//! the per-layout character tables printable input is typed through.
//!
//! The admin panel stores guacd's `server-layout` names, so the same
//! connection record has to keep working after the engine swap.
//!
//! The character tables are guacd's own RDP keymaps (Apache-2.0, from
//! `apache/guacamole-server` `src/protocols/rdp/keymaps/`), embedded
//! verbatim and parsed on first use.

use std::collections::HashMap;
use std::sync::OnceLock;

use super::keycodes::Scancode;

/// Windows layout id for a guacd `server-layout` name.
///
/// The id tells the target what kind of keyboard the session has, and
/// selects the [`Keymap`] printable characters are typed through.
///
/// `failsafe` returns `None`: guacd used it to select Unicode events
/// instead of scancodes, and the caller keeps that meaning.
pub fn keyboard_layout_id(name: &str) -> Option<u32> {
    let id = match name.trim().to_ascii_lowercase().as_str() {
        "en-us-qwerty" => 0x0000_0409,
        "en-gb-qwerty" => 0x0000_0809,
        "de-de-qwertz" => 0x0000_0407,
        "de-ch-qwertz" => 0x0000_0807,
        "fr-fr-azerty" => 0x0000_040c,
        "fr-ch-qwertz" => 0x0000_100c,
        "fr-be-azerty" => 0x0000_080c,
        "it-it-qwerty" => 0x0000_0410,
        "es-es-qwerty" => 0x0000_040a,
        "es-latam-qwerty" => 0x0000_080a,
        "pt-br-qwerty" => 0x0000_0416,
        "pt-pt-qwerty" => 0x0000_0816,
        "sv-se-qwerty" => 0x0000_041d,
        "da-dk-qwerty" => 0x0000_0406,
        "no-no-qwerty" => 0x0000_0414,
        "fi-fi-qwerty" => 0x0000_040b,
        "hu-hu-qwertz" => 0x0000_040e,
        "ja-jp-qwerty" => 0x0000_0411,
        "tr-tr-qwerty" => 0x0000_041f,
        _ => return None,
    };
    Some(id)
}

/// How to type one character on a given layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyStroke {
    /// Key position.
    pub scancode: Scancode,
    /// Whether Shift must be down.
    pub shift: bool,
    /// Whether AltGr must be down.
    pub altgr: bool,
}

impl KeyStroke {
    fn modifier_count(self) -> u8 {
        u8::from(self.shift) + u8::from(self.altgr)
    }
}

/// Character-to-key table for one layout, keyed by keysym.
#[derive(Debug, Default)]
pub struct Keymap {
    strokes: HashMap<u32, KeyStroke>,
}

impl Keymap {
    /// The key and modifiers that type `keysym` with Caps Lock off.
    #[must_use]
    pub fn stroke(&self, keysym: u32) -> Option<KeyStroke> {
        self.strokes.get(&keysym).copied()
    }

    /// Parse guacd's keymap syntax.
    ///
    /// Only `map` lines with a quoted character string are read; the
    /// hex-keysym lines are dead keys and IME toggles, which browsers do
    /// not deliver as keysyms. `+caps` lines are skipped because the
    /// engine keeps the target's Caps Lock off.
    fn parse(source: &str) -> Result<Self, String> {
        let mut keymap = Self::default();
        for (number, line) in source.lines().enumerate() {
            let line = line.trim();
            let Some(rule) = line.strip_prefix("map ") else {
                continue;
            };
            let Some((lhs, rhs)) = rule.split_once('~') else {
                return Err(format!("line {}: no '~'", number + 1));
            };
            let rhs = rhs.trim();
            let (Some(open), Some(close)) = (rhs.find('"'), rhs.rfind('"')) else {
                continue;
            };
            if open != 0 || close == open {
                continue;
            }
            let chars: Vec<char> = rhs[open + 1..close].chars().collect();

            let (mut shift, mut altgr, mut caps, mut scancodes) = (false, false, false, Vec::new());
            for token in lhs.split_whitespace() {
                match token {
                    "+shift" => shift = true,
                    "+altgr" => altgr = true,
                    "+caps" => caps = true,
                    "-shift" | "-altgr" | "-caps" => {}
                    _ => scancodes.extend(
                        parse_scancodes(token)
                            .ok_or_else(|| format!("line {}: bad token {token}", number + 1))?,
                    ),
                }
            }
            if caps {
                continue;
            }
            if chars.len() != scancodes.len() {
                return Err(format!(
                    "line {}: {} scancodes for {} characters",
                    number + 1,
                    scancodes.len(),
                    chars.len()
                ));
            }
            for (code, ch) in scancodes.into_iter().zip(chars) {
                let stroke = KeyStroke {
                    scancode: Scancode::plain(code),
                    shift,
                    altgr,
                };
                // Prefer the stroke needing fewest modifiers; on a tie the
                // first definition wins, as in guacd.
                keymap
                    .strokes
                    .entry(char_keysym(ch))
                    .and_modify(|existing| {
                        if stroke.modifier_count() < existing.modifier_count() {
                            *existing = stroke;
                        }
                    })
                    .or_insert(stroke);
            }
        }
        Ok(keymap)
    }
}

/// `0x29`, or an inclusive range `0x10..0x1B`.
fn parse_scancodes(token: &str) -> Option<Vec<u8>> {
    let hex = |s: &str| u8::from_str_radix(s.strip_prefix("0x")?, 16).ok();
    match token.split_once("..") {
        Some((from, to)) => Some((hex(from)?..=hex(to)?).collect()),
        None => Some(vec![hex(token)?]),
    }
}

/// The keysym the browser sends for `ch` (see `keymap::keysym_to_char`).
fn char_keysym(ch: char) -> u32 {
    let code = u32::from(ch);
    if code <= 0xff {
        code
    } else {
        0x0100_0000 | code
    }
}

/// Keymap source for each Windows layout id.
const KEYMAP_SOURCES: &[(u32, &str)] = &[
    (0x0409, include_str!("keymaps/en_us_qwerty.keymap")),
    (0x0809, include_str!("keymaps/en_gb_qwerty.keymap")),
    (0x0407, include_str!("keymaps/de_de_qwertz.keymap")),
    (0x0807, include_str!("keymaps/de_ch_qwertz.keymap")),
    (0x040c, include_str!("keymaps/fr_fr_azerty.keymap")),
    (0x100c, include_str!("keymaps/fr_ch_qwertz.keymap")),
    (0x080c, include_str!("keymaps/fr_be_azerty.keymap")),
    (0x0410, include_str!("keymaps/it_it_qwerty.keymap")),
    (0x040a, include_str!("keymaps/es_es_qwerty.keymap")),
    (0x080a, include_str!("keymaps/es_latam_qwerty.keymap")),
    (0x0416, include_str!("keymaps/pt_br_qwerty.keymap")),
    (0x0816, include_str!("keymaps/pt_pt_qwerty.keymap")),
    (0x041d, include_str!("keymaps/sv_se_qwerty.keymap")),
    (0x0406, include_str!("keymaps/da_dk_qwerty.keymap")),
    (0x0414, include_str!("keymaps/no_no_qwerty.keymap")),
    // Windows' Finnish layout is the Swedish one; guacd ships no fi_fi.
    (0x040b, include_str!("keymaps/sv_se_qwerty.keymap")),
    (0x040e, include_str!("keymaps/hu_hu_qwertz.keymap")),
    (0x0411, include_str!("keymaps/ja_jp_qwerty.keymap")),
    (0x041f, include_str!("keymaps/tr_tr_qwerty.keymap")),
];

/// The character table for a Windows layout id, if one is bundled.
#[must_use]
pub fn keymap_for_layout(layout_id: u32) -> Option<&'static Keymap> {
    static KEYMAPS: OnceLock<HashMap<u32, Keymap>> = OnceLock::new();
    KEYMAPS
        .get_or_init(|| {
            KEYMAP_SOURCES
                .iter()
                .filter_map(|(id, source)| match Keymap::parse(source) {
                    Ok(keymap) => Some((*id, keymap)),
                    Err(err) => {
                        tracing::error!(layout = id, %err, "bundled keymap failed to parse");
                        None
                    }
                })
                .collect()
        })
        .get(&layout_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(code: u8, shift: bool, altgr: bool) -> Option<KeyStroke> {
        Some(KeyStroke {
            scancode: Scancode::plain(code),
            shift,
            altgr,
        })
    }

    #[test]
    fn every_bundled_keymap_parses() {
        for (id, source) in KEYMAP_SOURCES {
            let keymap = Keymap::parse(source).unwrap_or_else(|e| panic!("{id:#06x}: {e}"));
            assert!(keymap.strokes.len() > 40, "{id:#06x} is suspiciously small");
        }
    }

    #[test]
    fn uk_symbols_use_uk_positions() {
        // The #420 characters: a US table types these on the wrong keys
        // of a UK target.
        let uk = keymap_for_layout(0x0809).unwrap();
        assert_eq!(uk.stroke(u32::from(b'\\')), stroke(0x56, false, false));
        assert_eq!(uk.stroke(u32::from(b'#')), stroke(0x2b, false, false));
        assert_eq!(uk.stroke(u32::from(b'@')), stroke(0x28, true, false));
        assert_eq!(uk.stroke(u32::from(b'"')), stroke(0x03, true, false));
        assert_eq!(uk.stroke(0x00a3), stroke(0x04, true, false)); // £
        assert_eq!(uk.stroke(0x0100_20ac), stroke(0x05, false, true)); // €
    }

    #[test]
    fn us_symbols_use_us_positions() {
        let us = keymap_for_layout(0x0409).unwrap();
        assert_eq!(us.stroke(u32::from(b'\\')), stroke(0x2b, false, false));
        assert_eq!(us.stroke(u32::from(b'@')), stroke(0x03, true, false));
        assert_eq!(us.stroke(u32::from(b'A')), stroke(0x1e, true, false));
    }

    #[test]
    fn altgr_characters_carry_the_altgr_flag() {
        let de = keymap_for_layout(0x0407).unwrap();
        assert_eq!(de.stroke(u32::from(b'@')), stroke(0x10, false, true));
        assert_eq!(de.stroke(u32::from(b'\\')), stroke(0x0c, false, true));
        // QWERTZ swaps Y and Z.
        assert_eq!(de.stroke(u32::from(b'z')), stroke(0x15, false, false));
    }

    #[test]
    fn caps_lock_rows_are_not_used() {
        // `+caps -shift` maps 'Q' unshifted; with the target's Caps Lock
        // held off that would type 'q'.
        let us = keymap_for_layout(0x0409).unwrap();
        assert_eq!(us.stroke(u32::from(b'Q')), stroke(0x10, true, false));
        assert_eq!(us.stroke(u32::from(b'q')), stroke(0x10, false, false));
    }

    #[test]
    fn finnish_uses_the_swedish_table() {
        assert_eq!(
            keymap_for_layout(0x040b).unwrap().stroke(0x00e4), // ä
            keymap_for_layout(0x041d).unwrap().stroke(0x00e4)
        );
    }

    #[test]
    fn unknown_layout_has_no_keymap() {
        assert!(keymap_for_layout(0x0405).is_none());
    }

    #[test]
    fn uk_english_is_not_us_english() {
        assert_eq!(keyboard_layout_id("en-gb-qwerty"), Some(0x0809));
        assert_eq!(keyboard_layout_id("en-us-qwerty"), Some(0x0409));
    }

    #[test]
    fn names_are_matched_case_and_space_insensitively() {
        assert_eq!(keyboard_layout_id(" EN-GB-Qwerty "), Some(0x0809));
    }

    #[test]
    fn unknown_and_failsafe_layouts_fall_back() {
        assert_eq!(keyboard_layout_id("failsafe"), None);
        assert_eq!(keyboard_layout_id(""), None);
        assert_eq!(keyboard_layout_id("kl-kl-qwerty"), None);
    }

    #[test]
    fn every_layout_the_admin_panel_offers_resolves() {
        // Mirrors frontend/src/pages/admin/rdpKeyboardLayouts.ts.
        for name in [
            "en-us-qwerty",
            "en-gb-qwerty",
            "de-de-qwertz",
            "de-ch-qwertz",
            "fr-fr-azerty",
            "fr-ch-qwertz",
            "fr-be-azerty",
            "it-it-qwerty",
            "es-es-qwerty",
            "es-latam-qwerty",
            "pt-br-qwerty",
            "pt-pt-qwerty",
            "sv-se-qwerty",
            "da-dk-qwerty",
            "no-no-qwerty",
            "fi-fi-qwerty",
            "hu-hu-qwertz",
            "ja-jp-qwerty",
            "tr-tr-qwerty",
        ] {
            assert!(keyboard_layout_id(name).is_some(), "{name} did not resolve");
            assert!(
                keyboard_layout_id(name)
                    .and_then(keymap_for_layout)
                    .is_some(),
                "{name} has no keymap"
            );
        }
    }
}
