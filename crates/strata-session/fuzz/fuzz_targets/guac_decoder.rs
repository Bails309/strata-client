#![no_main]
//! Fuzz the streaming decoder by feeding the input in arbitrary chunks.
//!
//! Chunking is where a length-prefixed decoder goes wrong: an instruction
//! split mid-UTF-8-sequence must be treated as incomplete, never as
//! malformed and never as a short read that desynchronises the stream.

use libfuzzer_sys::fuzz_target;
use strata_session::transport::GuacDecoder;

fuzz_target!(|data: &[u8]| {
    if data.is_empty() {
        return;
    }
    // First byte picks a chunk size, the rest is the stream.
    let chunk = usize::from(data[0]).max(1);
    let mut decoder = GuacDecoder::new(1024 * 1024);
    for slice in data[1..].chunks(chunk) {
        decoder.extend(slice);
        loop {
            match decoder.next_instruction() {
                Ok(Some(_)) => continue,
                // Incomplete: wait for the next chunk.
                Ok(None) => break,
                // Malformed input must be terminal, not a loop.
                Err(_) => return,
            }
        }
    }
});
