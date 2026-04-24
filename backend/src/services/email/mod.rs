//! Transactional email subsystem.
//!
//! ## Layering
//!
//! ```text
//!   services::notifications     (domain events — emits CheckoutEvent, etc.)
//!                │
//!                ▼
//!   services::email              (this module)
//!    ├── transport  ← `trait EmailTransport` + impls (SMTP, stub)
//!    ├── templates  ← MJML / plaintext render pipeline
//!    └── deliveries ← INSERT / UPDATE `email_deliveries` rows
//! ```
//!
//! The dispatcher is **always fire-and-forget** from the HTTP handler's
//! perspective — a failed send never propagates back to the requesting
//! user.  Delivery failures are recorded in the `email_deliveries` table
//! and retried (up to 3 attempts with exponential back-off) by the
//! background worker spawned at startup.

pub mod message;
pub mod outlook;
pub mod smtp;
pub mod templates;
pub mod transport;
pub mod worker;

pub use message::EmailAddress;
pub use message::EmailMessage;
#[allow(unused_imports)] // Re-exported for the upcoming P8 admin UI / P9 user-opt-out routes.
pub use message::InlineAttachment;

#[allow(unused_imports)] // Exposed for admin-UI consumers that will surface raw settings.
pub use smtp::SmtpSettings;
pub use smtp::SmtpTransport;
#[allow(unused_imports)]
// Consumed by admin SMTP config routes once P8 surfaces TLS mode selection.
pub use smtp::TlsMode;

pub use templates::TemplateKey;
#[allow(unused_imports)] // Re-exported so routes/tests can name the render pipeline.
pub use templates::{render, RenderError, RenderedEmail};

pub use transport::EmailTransport;
#[cfg(test)]
#[allow(unused_imports)]
pub use transport::StubTransport;
#[allow(unused_imports)] // Ready for P8/P9 dependency-injection + test harness wiring.
pub use transport::{BoxedTransport, SendError};

pub use worker::spawn_email_retry_worker;
