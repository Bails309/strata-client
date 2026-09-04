//! Guacamole Wire Compatibility Mode encoder.
//!
//! Produces byte-identical framing to guacd so an unmodified
//! `guacamole-common-js` client cannot tell which daemon it is talking
//! to. This is what makes the Phase 2 dual-stack rollout a routing
//! decision rather than a frontend release.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bytes::{Bytes, BytesMut};

use crate::engine::TargetEvent;
use crate::protocol::ServerInstruction;
use crate::transport::{ClientFrame, FrameEncoder, StreamingMode};

/// Raw bytes per `blob`, chosen so the base64 expansion lands on the
/// 6048-character chunk size guacd uses.
const MAX_BLOB_BYTES: usize = 4536;

/// Compositing mode for an opaque source-over draw.
const COMPOSITE_OVER: u8 = 12;

/// The default layer every engine draws to.
const DEFAULT_LAYER: i32 = 0;

/// Encodes target events as Guacamole text instructions.
#[derive(Debug)]
pub struct GuacWireEncoder {
    next_stream: i32,
    unsupported: u64,
}

impl Default for GuacWireEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl GuacWireEncoder {
    /// Create an encoder with a fresh stream-index counter.
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_stream: 1,
            unsupported: 0,
        }
    }

    /// Number of events this encoder could not represent.
    ///
    /// Non-zero means a session is silently losing updates — surfaced as
    /// a metric so a mis-routed session shows up in dashboards instead
    /// of as a user complaint about a frozen screen.
    #[must_use]
    pub fn unsupported_events(&self) -> u64 {
        self.unsupported
    }

    fn allocate_stream(&mut self) -> i32 {
        let stream = self.next_stream;
        // Stream 0 is reserved; wrap well below i32::MAX.
        self.next_stream = if self.next_stream >= 0x7FFF_FFFE {
            1
        } else {
            self.next_stream + 1
        };
        stream
    }

    /// Emit an image stream: `img`, one or more `blob`s, then `end`.
    fn encode_image(
        &mut self,
        x: i32,
        y: i32,
        mimetype: &str,
        data: &Bytes,
        out: &mut Vec<ClientFrame>,
    ) {
        let stream = self.allocate_stream();
        let mut buf = BytesMut::new();
        ServerInstruction::Img {
            stream,
            mask: COMPOSITE_OVER,
            layer: DEFAULT_LAYER,
            mimetype: mimetype.to_owned(),
            x,
            y,
        }
        .encode(&mut buf);
        for chunk in data.chunks(MAX_BLOB_BYTES) {
            ServerInstruction::Blob {
                stream,
                data: BASE64.encode(chunk),
            }
            .encode(&mut buf);
        }
        ServerInstruction::End { stream }.encode(&mut buf);
        out.push(ClientFrame::Text(buf.freeze()));
    }

    /// Emit a clipboard stream heading to the client.
    pub fn encode_clipboard(&mut self, data: &Bytes, out: &mut Vec<ClientFrame>) {
        let stream = self.allocate_stream();
        let mut buf = BytesMut::new();
        ServerInstruction::Clipboard {
            stream,
            mimetype: "text/plain".to_owned(),
        }
        .encode(&mut buf);
        for chunk in data.chunks(MAX_BLOB_BYTES) {
            ServerInstruction::Blob {
                stream,
                data: BASE64.encode(chunk),
            }
            .encode(&mut buf);
        }
        ServerInstruction::End { stream }.encode(&mut buf);
        out.push(ClientFrame::Text(buf.freeze()));
    }

    /// Emit the control instructions shared by both streaming modes.
    ///
    /// Returns `true` when `event` was handled.
    pub fn encode_control(&mut self, event: &TargetEvent, out: &mut Vec<ClientFrame>) -> bool {
        match event {
            TargetEvent::Resized { width, height } => {
                out.push(ClientFrame::Text(
                    ServerInstruction::Size {
                        layer: DEFAULT_LAYER,
                        width: *width,
                        height: *height,
                    }
                    .to_bytes()
                    .freeze(),
                ));
                true
            }
            TargetEvent::Disconnected { reason } => {
                out.push(ClientFrame::Text(
                    ServerInstruction::Error {
                        text: reason.clone(),
                        // 519 = UPSTREAM_ERROR in the Guacamole status set.
                        status: 519,
                    }
                    .to_bytes()
                    .freeze(),
                ));
                true
            }
            _ => false,
        }
    }
}

impl FrameEncoder for GuacWireEncoder {
    fn mode(&self) -> StreamingMode {
        StreamingMode::GuacWire
    }

    fn encode(&mut self, event: &TargetEvent, out: &mut Vec<ClientFrame>) {
        if self.encode_control(event, out) {
            return;
        }
        match event {
            TargetEvent::ImageUpdate {
                x,
                y,
                mimetype,
                data,
            } => self.encode_image(*x, *y, mimetype, data, out),
            TargetEvent::Clipboard(data) => self.encode_clipboard(data, out),
            // Compressed video and raw PTY bytes have no text
            // representation: reaching them requires a server-side
            // rasteriser (Phase 2). Count rather than silently drop.
            TargetEvent::VideoSlice { .. } | TargetEvent::TerminalOutput(_) => {
                self.unsupported += 1;
            }
            TargetEvent::Resized { .. } | TargetEvent::Disconnected { .. } => {
                unreachable!("control events are handled by encode_control")
            }
        }
    }

    fn sync(&mut self, timestamp_ms: i64, out: &mut Vec<ClientFrame>) {
        out.push(ClientFrame::Text(
            ServerInstruction::Sync {
                timestamp: timestamp_ms,
            }
            .to_bytes()
            .freeze(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::guacamole::try_parse_instruction;

    fn instructions(frames: &[ClientFrame]) -> Vec<(String, Vec<String>)> {
        let mut parsed = Vec::new();
        for frame in frames {
            let ClientFrame::Text(bytes) = frame else {
                panic!("guac wire mode must only emit text frames");
            };
            let mut rest: &[u8] = bytes;
            while !rest.is_empty() {
                let (instruction, consumed) = try_parse_instruction(rest).unwrap().unwrap();
                parsed.push((
                    instruction.opcode.to_owned(),
                    instruction.args.iter().map(|s| (*s).to_owned()).collect(),
                ));
                rest = &rest[consumed..];
            }
        }
        parsed
    }

    #[test]
    fn an_image_update_becomes_img_blob_end() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::ImageUpdate {
                x: 16,
                y: 32,
                mimetype: "image/webp",
                data: Bytes::from_static(b"RIFFfake"),
            },
            &mut out,
        );
        let parsed = instructions(&out);
        assert_eq!(
            parsed.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>(),
            vec!["img", "blob", "end"]
        );
        assert_eq!(parsed[0].1[3], "image/webp");
        assert_eq!(parsed[0].1[4], "16");
        assert_eq!(BASE64.decode(&parsed[1].1[1]).unwrap(), b"RIFFfake");
    }

    #[test]
    fn large_payloads_are_split_across_blobs() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        let payload = Bytes::from(vec![0xABu8; MAX_BLOB_BYTES * 2 + 7]);
        encoder.encode_clipboard(&payload, &mut out);
        let parsed = instructions(&out);
        let blobs: Vec<_> = parsed.iter().filter(|(op, _)| op == "blob").collect();
        assert_eq!(blobs.len(), 3);

        let mut reassembled = Vec::new();
        for (_, args) in blobs {
            reassembled.extend(BASE64.decode(&args[1]).unwrap());
        }
        assert_eq!(reassembled, payload.to_vec());
    }

    #[test]
    fn streams_get_distinct_indices() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        encoder.encode_clipboard(&Bytes::from_static(b"a"), &mut out);
        encoder.encode_clipboard(&Bytes::from_static(b"b"), &mut out);
        let parsed = instructions(&out);
        let opens: Vec<&String> = parsed
            .iter()
            .filter(|(op, _)| op == "clipboard")
            .map(|(_, args)| &args[0])
            .collect();
        assert_eq!(opens.len(), 2);
        assert_ne!(opens[0], opens[1]);
    }

    #[test]
    fn resize_and_disconnect_map_to_control_instructions() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::Resized {
                width: 1920,
                height: 1080,
            },
            &mut out,
        );
        encoder.encode(
            &TargetEvent::Disconnected {
                reason: "target closed".to_owned(),
            },
            &mut out,
        );
        let parsed = instructions(&out);
        assert_eq!(parsed[0].0, "size");
        assert_eq!(parsed[0].1, vec!["0", "1920", "1080"]);
        assert_eq!(parsed[1].0, "error");
        assert_eq!(parsed[1].1, vec!["target closed", "519"]);
    }

    #[test]
    fn events_with_no_text_representation_are_counted_not_dropped_silently() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::TerminalOutput(Bytes::from_static(b"$ ")),
            &mut out,
        );
        assert!(out.is_empty());
        assert_eq!(encoder.unsupported_events(), 1);
    }
}
