#![no_main]
//! Fuzz the AuthHello JSON parser. The internal node sends this as
//! the first frame on a fresh link; the DMZ MUST not crash, panic,
//! or hang on any byte sequence.

use libfuzzer_sys::fuzz_target;
use strata_protocol::handshake::AuthHello;

fuzz_target!(|data: &[u8]| {
    // Reject malformed UTF-8 cheaply; serde_json already does this
    // but we want the harness to spend cycles on parser internals,
    // not on UTF-8 validation.
    if std::str::from_utf8(data).is_err() {
        return;
    }
    let _ = serde_json::from_slice::<AuthHello>(data);
});
