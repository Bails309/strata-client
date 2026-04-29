//! Display-formatting helpers shared across HTTP-emitted strings (audit
//! emails, UI hints, etc.).
//!
//! The two utilities below — `format_datetime_for_display` and
//! `cn_from_dn` — exist because the same values surface in two
//! independent places (the in-app UI and outbound notification email)
//! and we want them to read **identically** in both.  Without these
//! helpers the email pipeline was hard-coding `%Y-%m-%d %H:%M UTC` and
//! a naive `split(',')` CN extractor that mis-handled escaped commas
//! like `CN=Bailey\, Matt`.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use sqlx::{Pool, Postgres};

use crate::services::settings;

/// Format a UTC timestamp using the tenant-configured display timezone,
/// date format, and time format.  Falls back to `YYYY-MM-DD HH:MM UTC`
/// if any setting is unreadable or the timezone string isn't a valid
/// IANA zone.
///
/// Format strings honoured (matching the frontend `utils/time.ts`
/// vocabulary):
///   * Date: `YYYY-MM-DD` (default), `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-MM-YYYY`
///   * Time: `HH:mm:ss` (default), `HH:mm`, `hh:mm:ss A`, `hh:mm A`
pub async fn format_datetime_for_display(pool: &Pool<Postgres>, ts: DateTime<Utc>) -> String {
    let tz_name = settings::get(pool, "display_timezone")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "UTC".into());
    let date_fmt = settings::get(pool, "display_date_format")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "YYYY-MM-DD".into());
    let time_fmt = settings::get(pool, "display_time_format")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "HH:mm:ss".into());

    // Resolve the tenant's IANA zone; bail out to a stable UTC string
    // rather than rendering something subtly wrong if the value is junk.
    let tz: Tz = match tz_name.parse() {
        Ok(t) => t,
        Err(_) => return ts.format("%Y-%m-%d %H:%M UTC").to_string(),
    };
    let local = ts.with_timezone(&tz);

    let date_str = match date_fmt.as_str() {
        "DD/MM/YYYY" => local.format("%d/%m/%Y").to_string(),
        "MM/DD/YYYY" => local.format("%m/%d/%Y").to_string(),
        "DD-MM-YYYY" => local.format("%d-%m-%Y").to_string(),
        _ => local.format("%Y-%m-%d").to_string(), // YYYY-MM-DD default
    };

    let hour12 = time_fmt.contains('A');
    let with_seconds = time_fmt.contains("ss");
    let time_str = match (hour12, with_seconds) {
        (true, true) => local.format("%I:%M:%S %p").to_string(),
        (true, false) => local.format("%I:%M %p").to_string(),
        (false, true) => local.format("%H:%M:%S").to_string(),
        (false, false) => local.format("%H:%M").to_string(),
    };

    // Timezone abbreviation (e.g. "BST", "EDT") for unambiguous emails.
    // Chrono renders this as a short name when the IANA zone is known.
    let zone = local.format("%Z").to_string();
    format!("{date_str} {time_str} {zone}")
}

/// Extract the `CN=` value from an LDAP distinguished name, correctly
/// handling RFC 4514 escaping (so `CN=Bailey\, Matt,OU=Users,DC=corp`
/// returns `Bailey, Matt`, not `Bailey\`).
///
/// The previous implementation used `split(',')` which broke on every
/// escaped comma inside a value.  This walks the string character-by-
/// character, treating `\,`, `\+`, `\<sp>`, `\#`, `\"`, `\\`, etc. as
/// literal characters that don't terminate the RDN.
pub fn cn_from_dn(dn: &str) -> Option<String> {
    let mut chars = dn.chars().peekable();
    let mut key = String::with_capacity(8);

    // Skip whitespace, read the attribute name up to '='.
    while let Some(&c) = chars.peek() {
        if c == '=' {
            chars.next();
            break;
        }
        key.push(c);
        chars.next();
    }
    if !key.eq_ignore_ascii_case("CN") {
        return None;
    }

    // Read the value, honouring `\<char>` and `\<HH>` (hex pair) escapes.
    let mut value = String::new();
    while let Some(c) = chars.next() {
        if c == ',' {
            break;
        }
        if c == '\\' {
            // RFC 4514 hex pair (e.g. `\2C` for ',').
            if let Some(&h1) = chars.peek() {
                if h1.is_ascii_hexdigit() {
                    let h1 = chars.next().unwrap();
                    if let Some(&h2) = chars.peek() {
                        if h2.is_ascii_hexdigit() {
                            let h2 = chars.next().unwrap();
                            if let Ok(byte) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                                value.push(byte as char);
                                continue;
                            }
                        }
                    }
                    // Lone hex digit: treat literally.
                    value.push(h1);
                    continue;
                }
                value.push(chars.next().unwrap());
                continue;
            }
            break;
        }
        value.push(c);
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cn_from_dn_simple() {
        assert_eq!(
            cn_from_dn("CN=svc-deploy-prod,OU=Service,DC=corp,DC=local").as_deref(),
            Some("svc-deploy-prod")
        );
    }

    #[test]
    fn cn_from_dn_escaped_comma() {
        assert_eq!(
            cn_from_dn("CN=Bailey\\, Matt,OU=Users,DC=corp,DC=local").as_deref(),
            Some("Bailey, Matt")
        );
    }

    #[test]
    fn cn_from_dn_hex_escape() {
        // \2C is the RFC 4514 hex form of ','
        assert_eq!(
            cn_from_dn("CN=Bailey\\2C Matt,OU=Users,DC=corp").as_deref(),
            Some("Bailey, Matt")
        );
    }

    #[test]
    fn cn_from_dn_lowercase_attr() {
        assert_eq!(cn_from_dn("cn=svc-foo,DC=corp").as_deref(), Some("svc-foo"));
    }

    #[test]
    fn cn_from_dn_no_cn() {
        assert_eq!(cn_from_dn("OU=People,DC=corp"), None);
    }

    #[test]
    fn cn_from_dn_empty_value() {
        assert_eq!(cn_from_dn("CN=,DC=corp"), None);
    }
}
