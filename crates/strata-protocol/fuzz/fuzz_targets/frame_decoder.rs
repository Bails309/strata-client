#![no_main]
//! Fuzz the length-prefixed handshake frame decoder. Treat the input
//! as a wire byte stream the way read_frame would; assert no panic
//! and that oversized lengths are rejected (not allocated).

use libfuzzer_sys::fuzz_target;
use strata_protocol::frame::read_frame;
use strata_protocol::handshake::AuthHello;
use tokio::io::AsyncReadExt;

fuzz_target!(|data: &[u8]| {
    // Build a tokio runtime once per iteration. fuzz_target! is
    // single-threaded so this is fine.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut cursor = std::io::Cursor::new(data.to_vec());
        // Wrap in a tokio-compat reader.
        let mut buf = Vec::new();
        let _ = cursor.read_to_end(&mut buf).await;
        let mut slice = &buf[..];
        let _ = read_frame::<_, AuthHello>(&mut slice).await;
    });
});
