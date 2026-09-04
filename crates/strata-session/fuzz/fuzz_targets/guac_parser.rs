#![no_main]
//! Fuzz the Guacamole instruction parser.
//!
//! This is the code path an unauthenticated-ish peer reaches first, and
//! the one guacd historically got wrong. Assert no panic, and that a
//! successful parse always reports a consumed length inside the input.

use libfuzzer_sys::fuzz_target;
use strata_session::protocol::guacamole::try_parse_instruction;

fuzz_target!(|data: &[u8]| {
    if let Ok(Some((instruction, consumed))) = try_parse_instruction(data) {
        assert!(consumed <= data.len(), "parser consumed past the input");
        assert!(consumed > 0, "a successful parse must make progress");
        // Every borrowed slice must point inside the input buffer.
        let range = data.as_ptr_range();
        for element in std::iter::once(instruction.opcode).chain(instruction.args) {
            let bytes = element.as_bytes();
            if !bytes.is_empty() {
                assert!(range.contains(&bytes.as_ptr()), "element escaped the input");
            }
        }
    }
});
