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
mod h2_serve;
mod registry;
// Phase 7 scaffolding: WebSocket session-resume registry. The map +
// HMAC token format are implemented and unit-tested; runtime
// integration with the `tunnel.rs` WebSocket upgrade path is deferred
// to a follow-on phase (browser-side reconnect handshake required).
// The dead-code suppression lives inside resume.rs as an inner
// attribute so it covers items defined in the module file.
mod resume;
mod router_adapter;
mod supervisor;
mod tls;

// `LinkEndpoint`, `BoxedStream`, `Connector`, and the body-cap
// constants are re-exported so tests and downstream code can name
// them; some are unused inside the binary today but kept as
// public-API surface.
#[allow(unused_imports)]
pub use config::{LinkConfig, LinkEndpoint};
#[allow(unused_imports)]
pub use connector::{BoxedStream, Connector};
// `RejectHandler` and the body-cap constants are re-exported so tests
// and the early supervisor wireup can name them; kept public-API even
// though the production wireup uses `RouterHandler`.
#[allow(unused_imports)]
pub use h2_serve::{
    serve_h2, RejectHandler, RequestHandler, MAX_CONCURRENT_STREAMS, MAX_REQUEST_BODY_BYTES,
};
pub use registry::{LinkRegistry, LinkState, LinkStatus};
// Phase 7 — see `mod resume` comment above.
#[allow(unused_imports)]
pub use resume::{spawn_sweeper, ResumeError, ResumeRegistry};
#[allow(unused_imports)]
pub use router_adapter::{RouterHandler, MAX_RESPONSE_BODY_BYTES};
pub use supervisor::spawn_link_supervisors;
pub use tls::TlsLinkConnector;
