#![no_main]
//! Fuzz the AuthChallenge JSON parser.

use libfuzzer_sys::fuzz_target;
use strata_protocol::handshake::AuthChallenge;

fuzz_target!(|data: &[u8]| {
    let _ = serde_json::from_slice::<AuthChallenge>(data);
});
