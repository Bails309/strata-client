//! DMZ link server: accepts inbound mTLS connections from internal
//! nodes, authenticates them, and exposes the resulting h2 sender
//! handles via [`LinkSessionRegistry`] for the reverse-proxy adapter.

mod listener;
mod registry;
mod tls;

pub use listener::{serve_link, LinkServerConfig};
pub use registry::{LinkSessionInfo, LinkSessionRegistry};
pub use tls::build_acceptor;
