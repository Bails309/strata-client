//! Wire-protocol versioning. Single source of truth for the link's
//! semver-style protocol version. Bumping `MAJOR` is a breaking change
//! and **must** be accompanied by a deprecation window in the runbook.

/// Major version of the link protocol. Incompatible changes bump this.
pub const PROTOCOL_VERSION_MAJOR: u16 = 1;

/// Minor version of the link protocol. Backward-compatible additions bump this.
pub const PROTOCOL_VERSION_MINOR: u16 = 0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn major_version_is_pinned() {
        // Bumping MAJOR is a breaking wire change. Update the deprecation
        // runbook (docs/dmz-implementation-plan.md) and bump this assertion
        // together so the change is impossible to land silently.
        assert_eq!(PROTOCOL_VERSION_MAJOR, 1);
    }

    #[test]
    fn minor_version_is_known() {
        // The minor version may move forward; this test exists so that any
        // change is intentional and reviewed alongside compat tests.
        assert_eq!(PROTOCOL_VERSION_MINOR, 0);
    }
}

/// Wire string for the protocol version, e.g. `"strata-link/1.0"`.
pub const PROTOCOL_VERSION_STR: &str = "strata-link/1.0";
