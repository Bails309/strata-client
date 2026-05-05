//! # strata-protocol
//!
//! Shared wire-protocol types and primitives for the Strata DMZ link.
//!
//! This crate is depended on by **both** [`strata-internal`] (the full
//! backend) and [`strata-dmz`] (the public-facing dumb-proxy). It must
//! remain free of:
//!
//! - Database / Vault / LDAP / Kerberos crates.
//! - Anything that pulls in `tokio` features beyond `sync` + `time`.
//!
//! See [`docs/dmz-implementation-plan.md`](../../../docs/dmz-implementation-plan.md)
//! for the full architectural rationale.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod handshake;
pub mod edge_header;
pub mod resume_token;
pub mod versioning;
pub mod errors;
pub mod frame;
pub mod backoff;
pub mod link;

pub use errors::ProtocolError;
