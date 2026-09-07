//! Native Direct Streaming Mode encoder.
//!
//! Compressed payloads are forwarded to the browser untouched, wrapped
//! in a [`MediaEnvelope`]. This is the half of the migration that pays
//! for itself: no Cairo surface, no bounding-box diffing, no PNG/WebP
//! re-compression — the H.264 slice that arrived on the RDP EGFX channel
//! is the H.264 slice the browser's `VideoDecoder` receives.
//!
//! Control traffic (resize, disconnect) still travels as Guacamole text
//! instructions on the same socket, which is why [`ClientFrame`]
//! distinguishes text from binary.

use bytes::{Bytes, BytesMut};
use strata_protocol::media::{MediaEnvelope, StreamType};

use crate::engine::{TargetEvent, VideoCodec};
use crate::transport::guac_wire::GuacWireEncoder;
use crate::transport::{ClientFrame, FrameEncoder, StreamingMode};

/// Encodes target events as binary media envelopes.
#[derive(Debug, Default)]
pub struct BinaryEncoder {
    control: GuacWireEncoder,
    dropped: u64,
}

impl BinaryEncoder {
    /// Create an encoder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Payloads refused because they exceeded the envelope size cap.
    #[must_use]
    pub fn dropped_payloads(&self) -> u64 {
        self.dropped
    }

    fn push_envelope(
        &mut self,
        stream_type: StreamType,
        timestamp_ms: u64,
        payload: &[u8],
        out: &mut Vec<ClientFrame>,
    ) {
        match MediaEnvelope::new(stream_type, timestamp_ms, payload) {
            Ok(envelope) => {
                let mut buf = BytesMut::with_capacity(envelope.encoded_len());
                envelope.encode(&mut buf);
                out.push(ClientFrame::Binary(buf.freeze()));
            }
            Err(err) => {
                self.dropped += 1;
                tracing::warn!(
                    ?stream_type,
                    bytes = payload.len(),
                    error = %err,
                    "dropping oversized media payload"
                );
            }
        }
    }
}

impl FrameEncoder for BinaryEncoder {
    fn mode(&self) -> StreamingMode {
        StreamingMode::Direct
    }

    fn encode(&mut self, event: &TargetEvent, out: &mut Vec<ClientFrame>) {
        if self.control.encode_control(event, out) {
            return;
        }
        match event {
            TargetEvent::VideoSlice {
                codec,
                timestamp_ms,
                data,
                ..
            } => match codec {
                VideoCodec::H264 => {
                    self.push_envelope(StreamType::H264Video, *timestamp_ms, data, out);
                }
                // AV1 has no envelope discriminant yet; forwarding it as
                // H.264 would hand the browser an undecodable stream.
                VideoCodec::Av1 => {
                    self.dropped += 1;
                    tracing::warn!("AV1 slices are not yet carried by the binary envelope");
                }
            },
            TargetEvent::TerminalOutput(data) => {
                self.push_envelope(StreamType::RawTerminal, 0, data, out);
            }
            TargetEvent::Clipboard(data) => {
                self.push_envelope(StreamType::ClipboardSync, 0, data, out);
            }
            // Raster fallbacks still occur on targets without EGFX; they
            // fall through to the text pipeline unchanged.
            TargetEvent::ImageUpdate { .. } => self.control.encode(event, out),
            TargetEvent::Resized { .. }
            | TargetEvent::Disconnected { .. }
            | TargetEvent::CursorImage { .. }
            | TargetEvent::CopyRegion { .. }
            | TargetEvent::CursorHidden => {
                unreachable!("control events are handled by encode_control")
            }
        }
    }

    fn sync(&mut self, timestamp_ms: i64, out: &mut Vec<ClientFrame>) {
        self.control.sync(timestamp_ms, out);
    }
}

/// Convenience: wrap raw terminal bytes for the direct pipeline.
#[must_use]
pub fn terminal_envelope(timestamp_ms: u64, data: &[u8]) -> Option<Bytes> {
    let envelope = MediaEnvelope::new(StreamType::RawTerminal, timestamp_ms, data).ok()?;
    Some(envelope.to_bytes().freeze())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_video_slice_is_forwarded_byte_for_byte() {
        let mut encoder = BinaryEncoder::new();
        let mut out = Vec::new();
        let nal = Bytes::from_static(b"\x00\x00\x00\x01\x65payload");
        encoder.encode(
            &TargetEvent::VideoSlice {
                codec: VideoCodec::H264,
                keyframe: true,
                timestamp_ms: 42,
                data: nal.clone(),
            },
            &mut out,
        );
        assert_eq!(out.len(), 1);
        let ClientFrame::Binary(bytes) = &out[0] else {
            panic!("video must be sent as a binary frame");
        };
        let (envelope, consumed) = MediaEnvelope::decode(bytes).unwrap().unwrap();
        assert_eq!(consumed, bytes.len());
        assert_eq!(envelope.stream_type, StreamType::H264Video);
        assert_eq!(envelope.timestamp_ms, 42);
        assert_eq!(envelope.payload, &nal[..]);
    }

    #[test]
    fn terminal_output_skips_rasterisation_entirely() {
        let mut encoder = BinaryEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::TerminalOutput(Bytes::from_static(b"user@host:~$ ")),
            &mut out,
        );
        let ClientFrame::Binary(bytes) = &out[0] else {
            panic!("terminal output must be sent as a binary frame");
        };
        let (envelope, _) = MediaEnvelope::decode(bytes).unwrap().unwrap();
        assert_eq!(envelope.stream_type, StreamType::RawTerminal);
        assert_eq!(envelope.payload, b"user@host:~$ ");
    }

    #[test]
    fn control_traffic_stays_on_the_text_channel() {
        let mut encoder = BinaryEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::Resized {
                width: 800,
                height: 600,
            },
            &mut out,
        );
        assert!(matches!(out[0], ClientFrame::Text(_)));
    }

    #[test]
    fn raster_fallback_still_produces_guacamole_images() {
        let mut encoder = BinaryEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::ImageUpdate {
                x: 0,
                y: 0,
                mimetype: "image/png",
                data: Bytes::from_static(b"\x89PNG"),
            },
            &mut out,
        );
        assert!(matches!(out[0], ClientFrame::Text(_)));
    }

    #[test]
    fn undecodable_codecs_are_refused_rather_than_mislabelled() {
        let mut encoder = BinaryEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::VideoSlice {
                codec: VideoCodec::Av1,
                keyframe: true,
                timestamp_ms: 1,
                data: Bytes::from_static(b"obu"),
            },
            &mut out,
        );
        assert!(out.is_empty());
        assert_eq!(encoder.dropped_payloads(), 1);
    }
}
