//! Two-stage email rendering pipeline.
//!
//! ```text
//!   Tera (variable + include expansion)
//!     ├── for HTML: feeds into mrml (MJML → responsive HTML),
//!     │            then [`outlook::wrap_for_outlook_dark_mode`].
//!     └── for plaintext: output is the rendered text body verbatim.
//! ```
//!
//! Templates are **embedded at compile time** via [`include_str!`] so
//! the production container ships a single binary with no on-disk
//! dependency.  Compilation of the Tera engine and parsing of the MJML
//! source happens lazily on first use, then the parsed tree is cached
//! per-template via [`OnceLock`].

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;
use tera::{Context, Tera};

use crate::services::email::outlook;

/// Identifier for the four supported notification templates.  Maps to
/// both the MJML template name and the plaintext companion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TemplateKey {
    CheckoutPending,
    CheckoutApproved,
    CheckoutRejected,
    CheckoutSelfApproved,
}

impl TemplateKey {
    /// Stable string used as the database `email_deliveries.template_key`
    /// column value and the Tera template lookup key.
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateKey::CheckoutPending => "checkout_pending",
            TemplateKey::CheckoutApproved => "checkout_approved",
            TemplateKey::CheckoutRejected => "checkout_rejected",
            TemplateKey::CheckoutSelfApproved => "checkout_self_approved",
        }
    }

    fn mjml_name(self) -> &'static str {
        match self {
            TemplateKey::CheckoutPending => "checkout_pending.mjml",
            TemplateKey::CheckoutApproved => "checkout_approved.mjml",
            TemplateKey::CheckoutRejected => "checkout_rejected.mjml",
            TemplateKey::CheckoutSelfApproved => "checkout_self_approved.mjml",
        }
    }

    fn text_name(self) -> &'static str {
        match self {
            TemplateKey::CheckoutPending => "checkout_pending.txt.tera",
            TemplateKey::CheckoutApproved => "checkout_approved.txt.tera",
            TemplateKey::CheckoutRejected => "checkout_rejected.txt.tera",
            TemplateKey::CheckoutSelfApproved => "checkout_self_approved.txt.tera",
        }
    }

    /// Default human-friendly subject line.  May be overridden at the
    /// dispatch layer if the caller wants per-event subject context.
    pub fn default_subject(self) -> &'static str {
        match self {
            TemplateKey::CheckoutPending => "Checkout request awaiting your approval",
            TemplateKey::CheckoutApproved => "Your checkout was approved",
            TemplateKey::CheckoutRejected => "Your checkout request was declined",
            TemplateKey::CheckoutSelfApproved => "Self-approved checkout — audit notice",
        }
    }
}

// ── Embedded sources ──────────────────────────────────────────────────
//
// Templates are intentionally **standalone** (no `{% include %}`). The
// MJML parser used by `mrml` is strict about mixed indentation produced
// by Tera includes, so each notification embeds its own complete
// `<mjml>` document.

const PENDING_MJML: &str = include_str!("templates/checkout_pending.mjml");
const APPROVED_MJML: &str = include_str!("templates/checkout_approved.mjml");
const REJECTED_MJML: &str = include_str!("templates/checkout_rejected.mjml");
const SELF_APPROVED_MJML: &str = include_str!("templates/checkout_self_approved.mjml");

const PENDING_TXT: &str = include_str!("templates/checkout_pending.txt.tera");
const APPROVED_TXT: &str = include_str!("templates/checkout_approved.txt.tera");
const REJECTED_TXT: &str = include_str!("templates/checkout_rejected.txt.tera");
const SELF_APPROVED_TXT: &str = include_str!("templates/checkout_self_approved.txt.tera");

// ── Engine bootstrap ──────────────────────────────────────────────────

/// One Tera engine for the whole process.
fn engine() -> &'static Tera {
    static ENGINE: OnceLock<Tera> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let mut t = Tera::default();
        t.add_raw_templates(vec![
            ("checkout_pending.mjml", PENDING_MJML),
            ("checkout_approved.mjml", APPROVED_MJML),
            ("checkout_rejected.mjml", REJECTED_MJML),
            ("checkout_self_approved.mjml", SELF_APPROVED_MJML),
            ("checkout_pending.txt.tera", PENDING_TXT),
            ("checkout_approved.txt.tera", APPROVED_TXT),
            ("checkout_rejected.txt.tera", REJECTED_TXT),
            ("checkout_self_approved.txt.tera", SELF_APPROVED_TXT),
        ])
        .expect("Tera template registration failed at startup");
        // Disable autoescape on every extension — MJML and plaintext are
        // not HTML, and we sanitise user-supplied values ourselves with
        // [`xml_escape`] before insertion.
        t.autoescape_on(vec![]);
        t
    })
}

// ── Public render API ─────────────────────────────────────────────────

/// Output of [`render`].  Both bodies are populated; callers wrap them
/// into the multipart message themselves.
pub struct RenderedEmail {
    pub html_body: String,
    pub text_body: String,
}

/// Render a notification template with the supplied context.
///
/// `ctx` is serialised to a Tera context.  String fields are run through
/// `ammonia::clean_text` (HTML-entity escape, no markup retained) so
/// user-supplied values like "Justification: <script>" become safe text
/// in the final HTML.  The plaintext template gets the *raw* values.
pub fn render<C: Serialize>(key: TemplateKey, ctx: &C) -> Result<RenderedEmail, RenderError> {
    let raw_value =
        serde_json::to_value(ctx).map_err(|e| RenderError::ContextSerialise(e.to_string()))?;

    let html_ctx = sanitised_context(&raw_value);
    let text_ctx = plain_context(&raw_value);

    // 1. Tera-expand the MJML source (variables only — templates are standalone).
    let expanded_mjml = engine()
        .render(key.mjml_name(), &html_ctx)
        .map_err(|e| RenderError::TeraMjml(e.to_string()))?;

    // 2. mrml parses MJML → renders responsive HTML.
    let parsed = mrml::parse(&expanded_mjml).map_err(|e| RenderError::MrmlParse(e.to_string()))?;
    let opts = mrml::prelude::render::RenderOptions::default();
    let raw_html = parsed
        .element
        .render(&opts)
        .map_err(|e| RenderError::MrmlRender(e.to_string()))?;

    // 3. Outlook dark-mode VML wrap.
    let html_body = outlook::wrap_for_outlook_dark_mode(&raw_html);

    // 4. Plaintext branch.
    let text_body = engine()
        .render(key.text_name(), &text_ctx)
        .map_err(|e| RenderError::TeraText(e.to_string()))?;

    Ok(RenderedEmail {
        html_body,
        text_body,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("serialise context: {0}")]
    ContextSerialise(String),
    #[error("tera (mjml): {0}")]
    TeraMjml(String),
    #[error("tera (text): {0}")]
    TeraText(String),
    #[error("mrml parse: {0}")]
    MrmlParse(String),
    #[error("mrml render: {0}")]
    MrmlRender(String),
}

/// Walk the JSON context recursively, HTML-encoding any string field.
/// `ammonia::clean_text` strips all markup and escapes `< > & ' "` to
/// the corresponding entities — exactly what we want before pasting
/// into MJML attribute values and `<mj-text>` bodies.
fn sanitised_context(value: &serde_json::Value) -> Context {
    let cleaned = clean_value(value);
    let map = cleaned.as_object().cloned().unwrap_or_default();
    let mut ctx = Context::new();
    for (k, v) in map {
        ctx.insert(&k, &v);
    }
    ctx
}

fn plain_context(value: &serde_json::Value) -> Context {
    let map = value.as_object().cloned().unwrap_or_default();
    let mut ctx = Context::new();
    for (k, v) in map {
        ctx.insert(&k, &v);
    }
    ctx
}

/// Walk the JSON context recursively, XML-escaping every string field.
///
/// We only escape the five XML-significant characters (`& < > " '`) —
/// this is the minimum required to prevent template injection while
/// keeping the rendered output legible (no `&#32;` for spaces, no entity
/// encoding of `/` or other punctuation).  Heavier sanitisers like
/// `ammonia::clean_text` produce output that mrml's strict XML parser
/// rejects when the value lands inside an attribute.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

fn clean_value(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => serde_json::Value::String(xml_escape(s)),
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.iter().map(clean_value).collect())
        }
        serde_json::Value::Object(o) => {
            let mut out = serde_json::Map::with_capacity(o.len());
            for (k, val) in o {
                out.insert(k.clone(), clean_value(val));
            }
            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

// Convenience: callers can build their context from a plain map without
// defining a per-template struct.
#[allow(dead_code)] // Used by the P8 admin UI test-send preview.
#[allow(dead_code)] // Used by the P8 admin UI test-send preview.
pub fn context_from_pairs(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_ctx() -> serde_json::Value {
        json!({
            "accent": "#2563eb",
            "requester_display_name": "Ada Lovelace",
            "requester_username": "ada",
            "target_account_cn": "svc-deploy-prod",
            "justification": "Patch Tuesday rollout",
            "requested_ttl_minutes": 60,
            "approve_url": "https://strata.example.com/admin/checkouts/abc",
            "profile_url": "https://strata.example.com/profile",
            "approver_display_name": "Grace Hopper",
            "expiry_human": "in 60 minutes",
        })
    }

    #[test]
    fn renders_pending_html_and_text() {
        let r = render(TemplateKey::CheckoutPending, &base_ctx()).unwrap();
        assert!(r.html_body.contains("Ada Lovelace"));
        assert!(r.html_body.contains("svc-deploy-prod"));
        assert!(r.html_body.contains("cid:strata-logo"));
        assert!(r.html_body.contains("<v:background"));
        assert!(r.text_body.contains("Ada Lovelace"));
        assert!(r.text_body.contains("svc-deploy-prod"));
    }

    #[test]
    fn renders_approved() {
        let r = render(TemplateKey::CheckoutApproved, &base_ctx()).unwrap();
        assert!(r.html_body.contains("Grace Hopper"));
        assert!(r.text_body.contains("Open Strata Profile"));
    }

    #[test]
    fn renders_rejected() {
        let r = render(TemplateKey::CheckoutRejected, &base_ctx()).unwrap();
        assert!(r.html_body.contains("declined"));
    }

    #[test]
    fn renders_self_approved() {
        let r = render(TemplateKey::CheckoutSelfApproved, &base_ctx()).unwrap();
        assert!(r.html_body.contains("audit"));
    }

    #[test]
    fn html_body_escapes_user_supplied_justification() {
        let mut ctx = base_ctx();
        ctx["justification"] = json!("<script>alert('xss')</script> & \"quoted\"");
        let r = render(TemplateKey::CheckoutPending, &ctx).unwrap();
        assert!(!r.html_body.contains("<script>"));
        // xml_escape encodes &, <, >, ', "
        assert!(r.html_body.contains("&lt;script&gt;"));
        assert!(r.html_body.contains("&amp;"));
    }

    #[test]
    fn plaintext_keeps_raw_justification() {
        let mut ctx = base_ctx();
        ctx["justification"] = json!("<not html>");
        let r = render(TemplateKey::CheckoutPending, &ctx).unwrap();
        assert!(r.text_body.contains("<not html>"));
    }

    #[test]
    fn template_keys_have_distinct_strings() {
        let all = [
            TemplateKey::CheckoutPending,
            TemplateKey::CheckoutApproved,
            TemplateKey::CheckoutRejected,
            TemplateKey::CheckoutSelfApproved,
        ];
        let mut seen = std::collections::HashSet::new();
        for k in all {
            assert!(seen.insert(k.as_str()), "duplicate key: {}", k.as_str());
        }
    }
}
