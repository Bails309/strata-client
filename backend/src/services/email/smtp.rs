//! Real SMTP transport built on `lettre`.
//!
//! Configuration is read from `system_settings` (keys seeded by migration
//! 055).  The password is sealed via Vault's Transit engine using the
//! same `seal_setting` / `unseal_setting` helpers as every other secret
//! held in `system_settings`.
//!
//! The transport is **rebuilt on demand** from the current settings (via
//! [`SmtpTransport::from_settings`]) rather than cached on the AppState,
//! because SMTP config can change at runtime through the admin UI and we
//! want the next send to pick up the new credentials without a restart.

use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use sqlx::{Pool, Postgres};

use crate::config::VaultConfig;
use crate::services::email::message::{EmailAddress, EmailMessage};
use crate::services::email::transport::{EmailTransport, SendError};
use crate::services::settings;

/// Production SMTP transport.
pub struct SmtpTransport {
    inner: AsyncSmtpTransport<Tokio1Executor>,
    /// Stored verbatim so [`describe`](EmailTransport::describe) can
    /// surface a concise audit-friendly identifier.
    host: String,
    port: u16,
}

// Manual `Debug` keeps the wrapped `lettre` transport (which doesn't
// implement `Debug`) and any future credential fields out of formatted
// output — only the host/port pair, which is already public via
// `describe`, is exposed.
impl std::fmt::Debug for SmtpTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpTransport")
            .field("host", &self.host)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// Concrete settings tuple loaded from the database.
///
/// Held briefly in memory while building the transport; never logged in
/// full (the password is the obvious sensitivity).
#[derive(Debug, Clone)]
pub struct SmtpSettings {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Plaintext password, already unsealed from Vault.  Empty if no
    /// password is required (e.g. relay on localhost).
    pub password: String,
    pub tls_mode: TlsMode,
    pub from_address: String,
    pub from_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    StartTls,
    Implicit,
    None,
}

impl TlsMode {
    fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "implicit" | "smtps" | "ssl" => TlsMode::Implicit,
            "none" | "off" | "" => TlsMode::None,
            _ => TlsMode::StartTls,
        }
    }
}

impl SmtpTransport {
    /// Load all SMTP settings from the database, unsealing the password
    /// via Vault if it is wrapped in the `vault:{...}` envelope.
    pub async fn load_settings(
        pool: &Pool<Postgres>,
        vault: Option<&VaultConfig>,
    ) -> Result<SmtpSettings, SendError> {
        async fn read(
            pool: &Pool<Postgres>,
            key: &str,
            default: &str,
        ) -> Result<String, SendError> {
            settings::get(pool, key)
                .await
                .map_err(|e| SendError::Permanent(format!("read setting {key}: {e}")))
                .map(|opt| opt.unwrap_or_else(|| default.into()))
        }

        let enabled = read(pool, "smtp_enabled", "false").await? == "true";
        let host = read(pool, "smtp_host", "").await?;
        let port = read(pool, "smtp_port", "587")
            .await?
            .parse::<u16>()
            .unwrap_or(587);
        let username = read(pool, "smtp_username", "").await?;
        let tls_mode = TlsMode::parse(&read(pool, "smtp_tls_mode", "starttls").await?);
        let from_address = read(pool, "smtp_from_address", "").await?;
        let from_name = read(pool, "smtp_from_name", "Strata Client").await?;

        let raw_password = read(pool, "smtp_encrypted_password", "").await?;
        let password = if raw_password.is_empty() {
            String::new()
        } else if let Some(vc) = vault {
            crate::services::vault::unseal_setting(vc, &raw_password)
                .await
                .map_err(|e| SendError::Permanent(format!("unseal smtp password: {e}")))?
        } else {
            // Vault not configured — value was stored as plaintext.  The
            // admin UI will refuse to save without Vault, so this only
            // matters for legacy deployments.
            raw_password
        };

        Ok(SmtpSettings {
            enabled,
            host,
            port,
            username,
            password,
            tls_mode,
            from_address,
            from_name,
        })
    }

    /// Build a ready-to-send transport from already-loaded settings.
    ///
    /// Returns [`SendError::Disabled`] when notifications are turned off
    /// or a required field (host / from address) is empty — these are
    /// configuration issues, not transport failures, so the dispatcher
    /// surfaces them as `suppressed` rather than `failed` rows.
    pub fn from_settings(s: &SmtpSettings) -> Result<Self, SendError> {
        if !s.enabled {
            return Err(SendError::Disabled("smtp_enabled is false".into()));
        }
        if s.host.is_empty() {
            return Err(SendError::Disabled("smtp_host is empty".into()));
        }
        if s.from_address.is_empty() {
            return Err(SendError::Disabled("smtp_from_address is empty".into()));
        }

        let mut builder = match s.tls_mode {
            TlsMode::Implicit => AsyncSmtpTransport::<Tokio1Executor>::relay(&s.host)
                .map_err(|e| SendError::Permanent(format!("smtp relay (implicit TLS): {e}")))?,
            TlsMode::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&s.host)
                .map_err(|e| SendError::Permanent(format!("smtp relay (STARTTLS): {e}")))?,
            TlsMode::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&s.host),
        }
        .port(s.port);

        if s.tls_mode == TlsMode::Implicit || s.tls_mode == TlsMode::StartTls {
            // lettre builds rustls params from `relay()`/`starttls_relay()`
            // by default; only override when an explicit hostname needs
            // pinning.  No-op here, kept as a hook.
            let _: Option<TlsParameters> = None;
            let _: Option<Tls> = None;
        }

        if !s.username.is_empty() && !s.password.is_empty() {
            builder = builder.credentials(Credentials::new(s.username.clone(), s.password.clone()));
        }

        Ok(SmtpTransport {
            inner: builder.build(),
            host: s.host.clone(),
            port: s.port,
        })
    }
}

#[async_trait::async_trait]
impl EmailTransport for SmtpTransport {
    async fn send(&self, message: &EmailMessage) -> Result<(), SendError> {
        let mime = build_mime(message)?;
        match self.inner.send(mime).await {
            Ok(_) => Ok(()),
            Err(e) => {
                // lettre exposes a structured error.  We use a coarse rule:
                // any error that contains `permanent` / a 5xx code is
                // permanent; everything else is transient (network
                // hiccups, DNS, TLS handshake, 4xx greylisting, etc.).
                let msg = format!("{e}");
                if is_permanent_failure(&msg) {
                    Err(SendError::Permanent(msg))
                } else {
                    Err(SendError::Transient(msg))
                }
            }
        }
    }

    fn describe(&self) -> String {
        format!("smtp:{}:{}", self.host, self.port)
    }
}

/// Build a `lettre::Message` (multipart/alternative + inline images) from
/// the neutral [`EmailMessage`].
fn build_mime(message: &EmailMessage) -> Result<Message, SendError> {
    let from: Mailbox = mailbox(&message.from)?;
    let to: Mailbox = mailbox(&message.to)?;

    let mut builder = Message::builder()
        .from(from)
        .to(to)
        .subject(&message.subject);
    if let Some(reply) = &message.reply_to {
        builder = builder.reply_to(mailbox(reply)?);
    }

    // multipart/alternative: text + html.  When inline attachments are
    // present we wrap the alternative in a multipart/related so the
    // `cid:` references resolve.
    let alternative = MultiPart::alternative()
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_PLAIN)
                .body(message.text_body.clone()),
        )
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(message.html_body.clone()),
        );

    let body = if message.inline_attachments.is_empty() {
        alternative
    } else {
        let mut related = MultiPart::related().multipart(alternative);
        for att in &message.inline_attachments {
            let ctype: ContentType = att
                .content_type
                .parse()
                .map_err(|e| SendError::Permanent(format!("invalid content-type: {e}")))?;
            related = related.singlepart(
                SinglePart::builder()
                    .header(ctype)
                    .header(lettre::message::header::ContentId::from(format!(
                        "<{}>",
                        att.content_id
                    )))
                    .header(lettre::message::header::ContentDisposition::inline())
                    .body(att.data.to_vec()),
            );
        }
        related
    };

    builder
        .multipart(body)
        .map_err(|e| SendError::Permanent(format!("build mime: {e}")))
}

fn mailbox(addr: &EmailAddress) -> Result<Mailbox, SendError> {
    let parsed = addr
        .address
        .parse()
        .map_err(|e| SendError::Permanent(format!("invalid address {}: {e}", addr.address)))?;
    Ok(match &addr.display_name {
        Some(name) => Mailbox::new(Some(name.clone()), parsed),
        None => Mailbox::new(None, parsed),
    })
}

fn is_permanent_failure(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("permanent")
        || lower.contains("550 ")
        || lower.contains("551 ")
        || lower.contains("552 ")
        || lower.contains("553 ")
        || lower.contains("554 ")
        || lower.contains("invalid address")
        || lower.contains("mailbox unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_mode_parse_normalises_aliases() {
        assert_eq!(TlsMode::parse("starttls"), TlsMode::StartTls);
        assert_eq!(TlsMode::parse("STARTTLS"), TlsMode::StartTls);
        assert_eq!(TlsMode::parse("implicit"), TlsMode::Implicit);
        assert_eq!(TlsMode::parse("smtps"), TlsMode::Implicit);
        assert_eq!(TlsMode::parse("ssl"), TlsMode::Implicit);
        assert_eq!(TlsMode::parse("none"), TlsMode::None);
        assert_eq!(TlsMode::parse(""), TlsMode::None);
        assert_eq!(TlsMode::parse("garbage"), TlsMode::StartTls);
    }

    #[test]
    fn from_settings_rejects_disabled() {
        let s = SmtpSettings {
            enabled: false,
            host: "mail.example.com".into(),
            port: 587,
            username: String::new(),
            password: String::new(),
            tls_mode: TlsMode::StartTls,
            from_address: "no-reply@example.com".into(),
            from_name: "Strata".into(),
        };
        let err = SmtpTransport::from_settings(&s).unwrap_err();
        assert!(matches!(err, SendError::Disabled(_)));
    }

    #[test]
    fn from_settings_rejects_empty_host() {
        let s = SmtpSettings {
            enabled: true,
            host: "".into(),
            port: 587,
            username: String::new(),
            password: String::new(),
            tls_mode: TlsMode::StartTls,
            from_address: "no-reply@example.com".into(),
            from_name: "Strata".into(),
        };
        let err = SmtpTransport::from_settings(&s).unwrap_err();
        assert!(matches!(err, SendError::Disabled(_)));
    }

    #[test]
    fn from_settings_rejects_empty_from() {
        let s = SmtpSettings {
            enabled: true,
            host: "mail.example.com".into(),
            port: 587,
            username: String::new(),
            password: String::new(),
            tls_mode: TlsMode::StartTls,
            from_address: "".into(),
            from_name: "Strata".into(),
        };
        let err = SmtpTransport::from_settings(&s).unwrap_err();
        assert!(matches!(err, SendError::Disabled(_)));
    }

    #[tokio::test]
    async fn from_settings_builds_with_starttls_and_credentials() {
        // Wrapped in #[tokio::test] because lettre's pool drop spawns
        // a cleanup task that requires an active Tokio reactor — even
        // though we never actually send.
        let s = SmtpSettings {
            enabled: true,
            host: "mail.example.com".into(),
            port: 587,
            username: "u".into(),
            password: "p".into(),
            tls_mode: TlsMode::StartTls,
            from_address: "no-reply@example.com".into(),
            from_name: "Strata".into(),
        };
        let t = SmtpTransport::from_settings(&s).unwrap();
        assert_eq!(t.describe(), "smtp:mail.example.com:587");
    }

    #[test]
    fn permanent_failure_classifier_recognises_5xx() {
        assert!(is_permanent_failure("550 mailbox unavailable"));
        assert!(is_permanent_failure("554 5.7.1 message rejected"));
        assert!(is_permanent_failure("Permanent error: invalid address"));
        assert!(!is_permanent_failure("connection reset"));
        assert!(!is_permanent_failure("dns lookup failed"));
        assert!(!is_permanent_failure("450 greylisted"));
    }

    #[test]
    fn build_mime_includes_inline_attachment() {
        let msg = EmailMessage::builder(
            EmailAddress::new("a@example.com"),
            EmailAddress::new("b@example.com"),
            "subject",
        )
        .html("<img src=\"cid:logo\">")
        .text("plain")
        .inline(crate::services::email::message::InlineAttachment {
            content_id: "logo".into(),
            content_type: "image/png".into(),
            data: std::borrow::Cow::Borrowed(&[1u8, 2, 3]),
        })
        .build();

        let mime = build_mime(&msg).unwrap();
        let formatted = String::from_utf8(mime.formatted()).unwrap();
        assert!(formatted.contains("multipart/related"));
        assert!(formatted.contains("Content-ID: <logo>"));
        assert!(formatted.contains("Content-Disposition: inline"));
    }
}
