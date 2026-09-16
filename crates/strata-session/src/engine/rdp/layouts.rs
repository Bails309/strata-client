//! Keyboard layout names to Windows layout identifiers.
//!
//! The admin panel stores guacd's `server-layout` names, so the same
//! connection record has to keep working after the engine swap.

/// Windows layout id for a guacd `server-layout` name.
///
/// The id tells the target what kind of keyboard the session has, which
/// governs the keys sent as positions: shortcuts, space and the named
/// keys. Printable characters do not depend on it, because they travel
/// as Unicode (see [`keycodes`](super::keycodes)).
///
/// `failsafe` returns `None` and so falls back to the default id. The
/// behaviour it selected in guacd -- Unicode events instead of scancodes
/// -- is now what every layout does for character input.
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

#[cfg(test)]
mod tests {
    use super::*;

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
        }
    }
}
