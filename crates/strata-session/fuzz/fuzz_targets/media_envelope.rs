#![no_main]
//! Fuzz the binary media envelope decoder.
//!
//! The declared payload length is attacker-controlled, so the decoder
//! must never allocate on it or index past the buffer.

use libfuzzer_sys::fuzz_target;
use strata_protocol::media::MediaEnvelope;

fuzz_target!(|data: &[u8]| {
    if let Ok(Some((envelope, consumed))) = MediaEnvelope::decode(data) {
        assert!(consumed <= data.len(), "decoder consumed past the input");
        assert_eq!(consumed, envelope.encoded_len());
        // Re-encoding a decoded envelope must reproduce the input prefix.
        assert_eq!(&envelope.to_bytes()[..], &data[..consumed]);
    }
});
