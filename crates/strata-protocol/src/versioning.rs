//! Wire-protocol versioning. Single source of truth for the link's
//! semver-style protocol version. Bumping `MAJOR` is a breaking change
//! and **must** be accompanied by a deprecation window in the runbook.

/// Major version of the link protocol. Incompatible changes bump this.
pub const PROTOCOL_VERSION_MAJOR: u16 = 1;

/// Minor version of the link protocol. Backward-compatible additions bump this.
pub const PROTOCOL_VERSION_MINOR: u16 = 0;

/// Wire string for the protocol version, e.g. `"strata-link/1.0"`.
pub const PROTOCOL_VERSION_STR: &str = "strata-link/1.0";
