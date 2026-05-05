//! Pluggable transport for the DMZ link supervisor.
//!
//! The trait is intentionally minimal: given an endpoint URL, hand back
//! a duplex byte stream. The supervisor speaks the link handshake +
//! HTTP/2 framing on top.
//!
//! Two implementations exist in tree:
//!
//! * The production TLS connector (Phase 1d) — TCP + rustls-0.23 with
//!   client cert + private CA truststore.
//! * A test connector backed by [`tokio::io::duplex`] paired with an
//!   in-process server task running the DMZ side of the handshake.

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};

use super::config::LinkEndpoint;

/// Type-erased duplex byte stream. `Unpin` is required so we can call
/// the `AsyncReadExt`/`AsyncWriteExt` extension methods directly without
/// pinning gymnastics in the supervisor loop.
pub type BoxedStream = Box<dyn AsyncReadWrite + Send + Unpin>;

/// Convenience composite trait for `AsyncRead + AsyncWrite + Send`.
pub trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> AsyncReadWrite for T {}

/// Pluggable link transport.
#[async_trait]
pub trait Connector: Send + Sync + 'static {
    /// Open a fresh duplex connection to the supplied endpoint.
    async fn connect(&self, endpoint: &LinkEndpoint) -> anyhow::Result<BoxedStream>;
}
