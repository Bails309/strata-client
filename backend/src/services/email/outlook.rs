//! VML / conditional-CSS wrapping for Outlook desktop dark-mode.
//!
//! Outlook (the Win32 desktop app) ignores `color-scheme`, ignores
//! `prefers-color-scheme`, and aggressively inverts `bgcolor=` attributes
//! and CSS `background-color` declarations on `<table>` / `<td>` /
//! `<div>`.  The result is a hazy off-grey rectangle floating over the
//! intended dark background.
//!
//! The only reliable workaround is a VML `<v:background>` shape rendered
//! by Word's HTML engine — VML is **not** subject to Outlook's
//! dark-mode inversion pass — combined with an Outlook-only conditional
//! stylesheet that reasserts the dark background on every container.
//!
//! This is documented in the user's persistent memory note
//! "outlook-dark-mode-email.md"; keep the two in sync if either changes.

const VML_BACKGROUND_OPEN: &str = concat!(
    "<!--[if gte mso 9]>",
    "<v:background xmlns:v=\"urn:schemas-microsoft-com:vml\" fill=\"t\">",
    "<v:fill type=\"tile\" color=\"#111827\"/>",
    "</v:background>",
    "<![endif]-->"
);

/// Inject the VML namespace, the `<v:background>` shape, and an
/// Outlook-only stylesheet into an MJML-rendered HTML document.
///
/// Idempotent: calling twice produces the same output as calling once
/// (we look for sentinel substrings before injecting).
pub fn wrap_for_outlook_dark_mode(html: &str) -> String {
    let mut out = html.to_owned();

    // 1. Add VML namespace to the <html> tag (required for <v:background>
    //    to be recognised by Word's HTML engine).
    if !out.contains("xmlns:v=\"urn:schemas-microsoft-com:vml\"") {
        if let Some(idx) = out.find("<html") {
            // Locate the end of the <html …> opening tag.
            if let Some(close) = out[idx..].find('>') {
                let insert_at = idx + close;
                out.insert_str(insert_at, " xmlns:v=\"urn:schemas-microsoft-com:vml\"");
            }
        }
    }

    // 2. Insert <v:background> immediately after <body …>.
    if !out.contains("<v:background") {
        if let Some(body_idx) = out.find("<body") {
            if let Some(close) = out[body_idx..].find('>') {
                let insert_at = body_idx + close + 1;
                out.insert_str(insert_at, VML_BACKGROUND_OPEN);
            }
        }
    }

    // 3. Inject Outlook-only CSS forcing the dark background on every
    //    container.  Outlook reads <style> only inside the head, but it
    //    will honour `<!--[if gte mso 9]>` conditional comments wrapping
    //    a <style>.  We slot it before </head> when present, otherwise
    //    before <body>.
    let outlook_css = "<!--[if gte mso 9]><style>\
        table, td, th, div, body { background-color: #111827 !important; color: #f9fafb !important; }\
        </style><![endif]-->";
    if !out.contains("background-color: #111827 !important") {
        if let Some(head_close) = out.find("</head>") {
            out.insert_str(head_close, outlook_css);
        } else if let Some(body_idx) = out.find("<body") {
            out.insert_str(body_idx, outlook_css);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "<!DOCTYPE html><html><head><title>x</title></head><body><table><tr><td>hi</td></tr></table></body></html>";

    #[test]
    fn injects_vml_namespace() {
        let out = wrap_for_outlook_dark_mode(SAMPLE);
        assert!(out.contains("xmlns:v=\"urn:schemas-microsoft-com:vml\""));
    }

    #[test]
    fn injects_vml_background_after_body() {
        let out = wrap_for_outlook_dark_mode(SAMPLE);
        assert!(out.contains("<v:background"));
        assert!(out.contains("color=\"#111827\""));
        // <v:background> must appear after <body>, not in the head.
        let body_pos = out.find("<body").unwrap();
        let vml_pos = out.find("<v:background").unwrap();
        assert!(vml_pos > body_pos);
    }

    #[test]
    fn injects_outlook_only_css() {
        let out = wrap_for_outlook_dark_mode(SAMPLE);
        assert!(out.contains("<!--[if gte mso 9]><style>"));
        assert!(out.contains("background-color: #111827 !important"));
    }

    #[test]
    fn is_idempotent() {
        let once = wrap_for_outlook_dark_mode(SAMPLE);
        let twice = wrap_for_outlook_dark_mode(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn handles_missing_head_gracefully() {
        let html = "<html><body>hi</body></html>";
        let out = wrap_for_outlook_dark_mode(html);
        // CSS slot falls back to before <body>.
        let css_pos = out.find("<!--[if gte mso 9]><style>").unwrap();
        let body_pos = out.find("<body").unwrap();
        assert!(css_pos < body_pos);
    }
}
