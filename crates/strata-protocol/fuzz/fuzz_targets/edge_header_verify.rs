#![no_main]
//! Fuzz the edge-header verifier. Feeds arbitrary JSON-shaped maps
//! and arbitrary MAC strings; verifier MUST NOT crash on any input.

use libfuzzer_sys::fuzz_target;
use std::collections::HashMap;
use strata_protocol::edge_header::verify;

fuzz_target!(|data: &[u8]| {
    // Split data: first byte = length of MAC slice, rest split in
    // half between headers JSON and MAC.
    if data.len() < 4 {
        return;
    }
    let split = (data[0] as usize) % data.len().max(1);
    let (a, b) = data[1..].split_at(split.min(data.len() - 1));
    let Ok(headers_str) = std::str::from_utf8(a) else { return };
    let Ok(mac_str) = std::str::from_utf8(b) else { return };

    let headers: HashMap<String, String> =
        serde_json::from_str(headers_str).unwrap_or_default();
    let key: &[u8] = b"fuzz-key-fuzz-key-fuzz-key-fuzz!";
    let _ = verify(&headers, mac_str, &[key]);
});
