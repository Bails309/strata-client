//! Client-facing transport: instruction decoding and frame encoding.
//!
//! Two encoders sit behind [`FrameEncoder`], matching the dual-track
//! architecture:
//!
//! - [`guac_wire::GuacWireEncoder`] — Guacamole Wire Compatibility Mode.
//!   Byte-identical framing to guacd, so existing `guacamole-common-js`
//!   clients connect unmodified.
//! - [`binary::BinaryEncoder`] — Native Direct Streaming Mode. Compressed
//!   video and raw PTY bytes are wrapped in a
//!   [`MediaEnvelope`](strata_protocol::media::MediaEnvelope) and decoded
//!   in the browser by WebCodecs / `xterm.js`.

use bytes::Bytes;

use crate::engine::TargetEvent;

pub mod binary;
pub mod decoder;
pub mod guac_wire;

pub use binary::BinaryEncoder;
pub use decoder::GuacDecoder;
pub use guac_wire::GuacWireEncoder;

/// Which downstream pipeline a session negotiated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamingMode {
    /// Legacy text instructions, server-side rasterisation.
    GuacWire,
    /// Binary envelopes, client-side hardware decoding.
    Direct,
}

/// One WebSocket message ready to send.
///
/// The distinction matters: a Guacamole client reads text frames, and a
/// binary frame delivered to the text path would be silently dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientFrame {
    /// UTF-8 Guacamole instructions.
    Text(Bytes),
    /// A binary media envelope.
    Binary(Bytes),
}

impl ClientFrame {
    /// Payload bytes, regardless of framing.
    #[must_use]
    pub fn payload(&self) -> &Bytes {
        match self {
            Self::Text(b) | Self::Binary(b) => b,
        }
    }

    /// Encoded size in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.payload().len()
    }

    /// Whether the frame carries no payload.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.payload().is_empty()
    }
}

/// Turns target events into frames for one client.
pub trait FrameEncoder: Send {
    /// The mode this encoder implements.
    fn mode(&self) -> StreamingMode;

    /// Encode `event`, appending zero or more frames to `out`.
    fn encode(&mut self, event: &TargetEvent, out: &mut Vec<ClientFrame>);

    /// Emit a frame boundary carrying `timestamp_ms`.
    fn sync(&mut self, timestamp_ms: i64, out: &mut Vec<ClientFrame>);
}
