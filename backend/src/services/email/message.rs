//! Transport-agnostic email message representation.
//!
//! `EmailMessage` is the neutral data type passed to the [`super::transport::EmailTransport`]
//! trait.  It carries everything required to construct a real MIME multipart
//! message (HTML body, plaintext body, inline attachments referenced by
//! Content-ID) without coupling the rest of the codebase to any particular
//! transport library.

use std::borrow::Cow;

/// An RFC-5322 address plus an optional display name.
///
/// Rendered as `"Display Name" <local@example.com>` when a display name is
/// present; otherwise as a bare address.  Both parts are validated by the
/// transport at send time — we deliberately keep validation cheap here so
/// unit tests can build messages freely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailAddress {
    pub address: String,
    pub display_name: Option<String>,
}

impl EmailAddress {
    pub fn new(address: impl Into<String>) -> Self {
        Self {
            address: address.into(),
            display_name: None,
        }
    }

    pub fn with_name(address: impl Into<String>, display_name: impl Into<String>) -> Self {
        Self {
            address: address.into(),
            display_name: Some(display_name.into()),
        }
    }
}

/// A binary attachment referenced from the HTML body via `cid:<content_id>`.
///
/// Used for the embedded logo so mail clients display the branded header
/// without the "external images blocked" warning that afflicts Outlook +
/// outlook.com when images are loaded from a remote URL.
#[derive(Debug, Clone)]
pub struct InlineAttachment {
    /// Value referenced by `<img src="cid:...">` in the HTML body.  Must be
    /// unique per message.
    pub content_id: String,
    /// MIME type, e.g. `"image/png"`.
    pub content_type: String,
    /// Raw bytes of the attachment.
    pub data: Cow<'static, [u8]>,
}

/// A fully-formed, transport-ready transactional email.
#[derive(Debug, Clone)]
pub struct EmailMessage {
    pub from: EmailAddress,
    pub to: EmailAddress,
    pub reply_to: Option<EmailAddress>,
    pub subject: String,
    /// Responsive HTML body (already rendered from MJML + Tera context and
    /// wrapped in the Outlook-dark-mode VML shim).
    pub html_body: String,
    /// Plaintext twin rendered from the same context; required for RFC-8058
    /// compliance and for mail clients that prefer text.
    pub text_body: String,
    pub inline_attachments: Vec<InlineAttachment>,
}

impl EmailMessage {
    pub fn builder(
        from: EmailAddress,
        to: EmailAddress,
        subject: impl Into<String>,
    ) -> EmailMessageBuilder {
        EmailMessageBuilder {
            inner: EmailMessage {
                from,
                to,
                reply_to: None,
                subject: subject.into(),
                html_body: String::new(),
                text_body: String::new(),
                inline_attachments: Vec::new(),
            },
        }
    }
}

pub struct EmailMessageBuilder {
    inner: EmailMessage,
}

impl EmailMessageBuilder {
    pub fn html(mut self, html: impl Into<String>) -> Self {
        self.inner.html_body = html.into();
        self
    }

    pub fn text(mut self, text: impl Into<String>) -> Self {
        self.inner.text_body = text.into();
        self
    }

    #[allow(dead_code)] // Used by the P8 admin UI test-send flow and by future templates.
    pub fn reply_to(mut self, addr: EmailAddress) -> Self {
        self.inner.reply_to = Some(addr);
        self
    }

    #[allow(dead_code)] // Used by templates that embed additional inline media beyond the logo.
    pub fn inline(mut self, attachment: InlineAttachment) -> Self {
        self.inner.inline_attachments.push(attachment);
        self
    }

    pub fn build(self) -> EmailMessage {
        self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_roundtrip() {
        let msg = EmailMessage::builder(
            EmailAddress::with_name("no-reply@example.com", "Strata Client"),
            EmailAddress::new("jdoe@corp.local"),
            "Checkout approved",
        )
        .html("<p>Hi</p>")
        .text("Hi")
        .inline(InlineAttachment {
            content_id: "logo".into(),
            content_type: "image/png".into(),
            data: std::borrow::Cow::Borrowed(&[0u8, 1, 2]),
        })
        .build();

        assert_eq!(msg.subject, "Checkout approved");
        assert_eq!(msg.from.display_name.as_deref(), Some("Strata Client"));
        assert_eq!(msg.to.address, "jdoe@corp.local");
        assert_eq!(msg.html_body, "<p>Hi</p>");
        assert_eq!(msg.text_body, "Hi");
        assert_eq!(msg.inline_attachments.len(), 1);
        assert_eq!(msg.inline_attachments[0].content_id, "logo");
    }

    #[test]
    fn reply_to_is_optional_and_defaults_unset() {
        let msg = EmailMessage::builder(
            EmailAddress::new("a@example.com"),
            EmailAddress::new("b@example.com"),
            "s",
        )
        .build();
        assert!(msg.reply_to.is_none());
    }
}
