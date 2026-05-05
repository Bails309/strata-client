//! Internal-side DMZ link supervisor.
//!
//! Spawned per-endpoint background task that:
//!
//! 1. Dials the DMZ over TLS (mTLS), via a [`Connector`] trait so the
//!    supervisor loop is testable with in-memory transports.
//! 2. Runs [`strata_protocol::link::client_handshake`] over the freshly
//!    opened stream.
//! 3. Holds the link "up" until the peer disconnects or returns an error.
//!    (Phase 1d will turn this into an HTTP/2 request multiplexer; this
//!    PR keeps the loop semantically correct without committing to h2
//!    yet.)
//! 4. On disconnect, applies decorrelated-jitter backoff
//!    ([`strata_protocol::backoff`]) before redialing.
//!
//! Status for every endpoint is published into a [`LinkRegistry`] so
//! admin-UI and `/readyz`-style endpoints can observe link state
//! without taking locks on the supervisor itself.

mod config;
mod connector;
mod registry;
mod supervisor;

pub use config::{LinkConfig, LinkEndpoint};
pub use connector::{BoxedStream, Connector};
pub use registry::{LinkRegistry, LinkState, LinkStatus};
pub use supervisor::spawn_link_supervisors;
