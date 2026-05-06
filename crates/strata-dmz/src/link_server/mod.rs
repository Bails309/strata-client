//! DMZ link server: accepts inbound mTLS connections from internal
//! nodes, authenticates them, and exposes the resulting h2 sender
//! handles via [`LinkSessionRegistry`] for the reverse-proxy adapter.

mod listener;
mod registry;
mod tls;

pub use listener::{serve_link, LinkServerConfig};
// `LinkSessionInfo` is only needed by tests in sibling modules; the binary
// itself doesn't reference it, but removing the re-export would force tests
// to reach into a private module. Suppress the unused-import warning that
// release builds emit.
#[allow(unused_imports)]
pub use registry::{LinkSessionInfo, LinkSessionRegistry};
pub use tls::build_acceptor;
