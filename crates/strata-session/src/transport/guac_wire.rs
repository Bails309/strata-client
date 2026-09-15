//! Guacamole Wire Compatibility Mode encoder.
//!
//! Produces byte-identical framing to guacd so an unmodified
//! `guacamole-common-js` client cannot tell which daemon it is talking
//! to. This is what makes the Phase 2 dual-stack rollout a routing
//! decision rather than a frontend release.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bytes::{Bytes, BytesMut};

use crate::engine::{FileEvent, TargetEvent, VideoCodec};
use crate::protocol::ServerInstruction;
use crate::transport::{ClientFrame, FrameEncoder, StreamingMode};

/// Raw bytes per `blob`, chosen so the base64 expansion lands on the
/// 6048-character chunk size guacd uses.
const MAX_BLOB_BYTES: usize = 4536;

/// Compositing mode for an opaque source-over draw.
///
/// Must stay `0xE`. The client maps `0xC` to the canvas `copy` operation,
/// which clears everything outside the drawn rectangle — a single small
/// update would blank the rest of the display.
const COMPOSITE_OVER: u8 = 14;

/// Compositing mode that replaces the destination entirely.
///
/// Only safe on a buffer sized exactly to the image. The cursor needs it:
/// `size` is a no-op when the dimensions are unchanged, so drawing a new
/// pointer with `COMPOSITE_OVER` would leave it stacked on the old one.
const COMPOSITE_SRC: u8 = 12;

/// The default layer every engine draws to.
const DEFAULT_LAYER: i32 = 0;

/// Off-screen buffer holding the cursor bitmap.
///
/// Guacamole buffers are negative layer indices; the client copies from
/// this one into its own pointer.
const CURSOR_LAYER: i32 = -1;

/// Mimetype declared on the audio stream.
///
/// Lives here rather than with the RDP engine because it describes what
/// this encoder puts on the wire, and the transport is compiled whether
/// or not that engine is.
pub const AUDIO_MIMETYPE: &str = "audio/L16;rate=44100,channels=2";

/// Encodes target events as Guacamole text instructions.
#[derive(Debug)]
pub struct GuacWireEncoder {
    next_stream: i32,
    unsupported: u64,
    /// The audio stream, opened on the first wave packet.
    ///
    /// One stream lasts the session: the player treats a stream as a
    /// continuous timeline and re-opening one per packet would restart
    /// its clock on every packet.
    audio_stream: Option<i32>,
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
            audio_stream: None,
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
        let mut buf = BytesMut::new();
        self.push_image(
            &mut buf,
            COMPOSITE_OVER,
            DEFAULT_LAYER,
            x,
            y,
            mimetype,
            data,
        );
        out.push(ClientFrame::Text(buf.freeze()));
    }

    /// Append `img` + `blob`s + `end` targeting `layer`.
    #[allow(clippy::too_many_arguments)]
    fn push_image(
        &mut self,
        buf: &mut BytesMut,
        mask: u8,
        layer: i32,
        x: i32,
        y: i32,
        mimetype: &str,
        data: &Bytes,
    ) {
        let stream = self.allocate_stream();
        ServerInstruction::Img {
            stream,
            mask,
            layer,
            mimetype: mimetype.to_owned(),
            x,
            y,
        }
        .encode(buf);
        for chunk in data.chunks(MAX_BLOB_BYTES) {
            ServerInstruction::Blob {
                stream,
                data: BASE64.encode(chunk),
            }
            .encode(buf);
        }
        ServerInstruction::End { stream }.encode(buf);
    }

    /// Emit a clipboard stream heading to the client.
    ///
    /// One frame per instruction, matching guacd: a multi-megabyte
    /// clipboard batched into a single frame would spike memory at both
    /// ends and defeat the point of chunking it into blobs.
    pub fn encode_clipboard(&mut self, data: &Bytes, out: &mut Vec<ClientFrame>) {
        let stream = self.allocate_stream();
        let mut header = BytesMut::new();
        ServerInstruction::Clipboard {
            stream,
            mimetype: "text/plain".to_owned(),
        }
        .encode(&mut header);
        out.push(ClientFrame::Text(header.freeze()));
        for chunk in data.chunks(MAX_BLOB_BYTES) {
            let mut buf = BytesMut::new();
            ServerInstruction::Blob {
                stream,
                data: BASE64.encode(chunk),
            }
            .encode(&mut buf);
            out.push(ClientFrame::Text(buf.freeze()));
        }
        let mut tail = BytesMut::new();
        ServerInstruction::End { stream }.encode(&mut tail);
        out.push(ClientFrame::Text(tail.freeze()));
    }

    /// Emit desktop audio, opening the stream on first use.
    ///
    /// The stream is never closed while the session lives. `end` would
    /// tell the player the sound had finished and make it tear down its
    /// buffer, so a pause between packets must look like silence, not a
    /// completed stream.
    pub fn encode_audio(&mut self, data: &Bytes, out: &mut Vec<ClientFrame>) {
        let stream = match self.audio_stream {
            Some(stream) => stream,
            None => {
                let stream = self.allocate_stream();
                self.audio_stream = Some(stream);
                let mut header = BytesMut::new();
                ServerInstruction::Audio {
                    stream,
                    mimetype: AUDIO_MIMETYPE.to_owned(),
                }
                .encode(&mut header);
                out.push(ClientFrame::Text(header.freeze()));
                stream
            }
        };
        for chunk in data.chunks(MAX_BLOB_BYTES) {
            let mut buf = BytesMut::new();
            ServerInstruction::Blob {
                stream,
                data: BASE64.encode(chunk),
            }
            .encode(&mut buf);
            out.push(ClientFrame::Text(buf.freeze()));
        }
    }

    /// Emit a file-transfer event.
    ///
    /// Stream indices come from the SFTP engine rather than this
    /// encoder's allocator: the client names them back in `ack` and
    /// `put`, so both ends must agree on who assigns them.
    pub fn encode_file(&mut self, event: &FileEvent, out: &mut Vec<ClientFrame>) {
        let instruction = match event {
            FileEvent::Filesystem { object, name } => ServerInstruction::Filesystem {
                object: *object,
                name: name.clone(),
            },
            FileEvent::Body {
                object,
                stream,
                mimetype,
                name,
            } => ServerInstruction::Body {
                object: *object,
                stream: *stream,
                mimetype: mimetype.clone(),
                name: name.clone(),
            },
            FileEvent::Data { stream, data } => {
                for chunk in data.chunks(MAX_BLOB_BYTES) {
                    let mut buf = BytesMut::new();
                    ServerInstruction::Blob {
                        stream: *stream,
                        data: BASE64.encode(chunk),
                    }
                    .encode(&mut buf);
                    out.push(ClientFrame::Text(buf.freeze()));
                }
                return;
            }
            FileEvent::End { stream } => ServerInstruction::End { stream: *stream },
            FileEvent::Ack {
                stream,
                message,
                status,
            } => ServerInstruction::Ack {
                stream: *stream,
                message: message.clone(),
                status: *status,
            },
        };
        let mut buf = BytesMut::new();
        instruction.encode(&mut buf);
        out.push(ClientFrame::Text(buf.freeze()));
    }

    /// Emit an H.264 video slice for client-side hardware WebCodecs decoding.
    pub fn encode_h264(&mut self, keyframe: bool, data: &Bytes, out: &mut Vec<ClientFrame>) {
        let stream = self.allocate_stream();
        let mut header = BytesMut::new();
        ServerInstruction::H264 {
            stream,
            layer: DEFAULT_LAYER,
            keyframe,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        }
        .encode(&mut header);
        out.push(ClientFrame::Text(header.freeze()));

        for chunk in data.chunks(MAX_BLOB_BYTES) {
            let mut buf = BytesMut::new();
            ServerInstruction::Blob {
                stream,
                data: BASE64.encode(chunk),
            }
            .encode(&mut buf);
            out.push(ClientFrame::Text(buf.freeze()));
        }

        let mut tail = BytesMut::new();
        ServerInstruction::End { stream }.encode(&mut tail);
        out.push(ClientFrame::Text(tail.freeze()));
    }

    /// Emit the control instructions shared by both streaming modes.
    ///
    /// Returns `true` when `event` was handled.
    pub fn encode_control(&mut self, event: &TargetEvent, out: &mut Vec<ClientFrame>) -> bool {
        match event {
            // Moving a region costs nine integers where repainting it
            // costs a PNG of the whole area.
            TargetEvent::CopyRegion {
                src_x,
                src_y,
                width,
                height,
                dst_x,
                dst_y,
            } => {
                out.push(ClientFrame::Text(
                    ServerInstruction::Copy {
                        src_layer: DEFAULT_LAYER,
                        src_x: *src_x,
                        src_y: *src_y,
                        width: *width,
                        height: *height,
                        mask: COMPOSITE_OVER,
                        dst_layer: DEFAULT_LAYER,
                        dst_x: *dst_x,
                        dst_y: *dst_y,
                    }
                    .to_bytes()
                    .freeze(),
                ));
                true
            }
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
            TargetEvent::CursorImage {
                hotspot_x,
                hotspot_y,
                width,
                height,
                mimetype,
                data,
            } => {
                let mut buf = BytesMut::new();
                // Sizing the buffer also clears the previous shape.
                ServerInstruction::Size {
                    layer: CURSOR_LAYER,
                    width: *width,
                    height: *height,
                }
                .encode(&mut buf);
                self.push_image(&mut buf, COMPOSITE_SRC, CURSOR_LAYER, 0, 0, mimetype, data);
                ServerInstruction::Cursor {
                    hotspot_x: *hotspot_x as i32,
                    hotspot_y: *hotspot_y as i32,
                    src_layer: CURSOR_LAYER,
                    src_x: 0,
                    src_y: 0,
                    src_width: *width,
                    src_height: *height,
                }
                .encode(&mut buf);
                out.push(ClientFrame::Text(buf.freeze()));
                true
            }
            TargetEvent::CursorHidden => {
                let mut buf = BytesMut::new();
                // A 1x1 empty buffer is the protocol's way to hide it.
                ServerInstruction::Size {
                    layer: CURSOR_LAYER,
                    width: 1,
                    height: 1,
                }
                .encode(&mut buf);
                ServerInstruction::Cursor {
                    hotspot_x: 0,
                    hotspot_y: 0,
                    src_layer: CURSOR_LAYER,
                    src_x: 0,
                    src_y: 0,
                    src_width: 1,
                    src_height: 1,
                }
                .encode(&mut buf);
                out.push(ClientFrame::Text(buf.freeze()));
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
            TargetEvent::Audio(data) => self.encode_audio(data, out),
            TargetEvent::File(event) => self.encode_file(event, out),
            TargetEvent::VideoSlice {
                codec: VideoCodec::H264,
                keyframe,
                data,
                ..
            } => self.encode_h264(*keyframe, data, out),
            TargetEvent::VideoSlice {
                codec: VideoCodec::Av1,
                ..
            }
            | TargetEvent::TerminalOutput(_) => {
                self.unsupported += 1;
            }
            // Handled by `encode_control` above, which runs first.
            TargetEvent::CopyRegion { .. } => {}
            TargetEvent::Resized { .. }
            | TargetEvent::Disconnected { .. }
            | TargetEvent::CursorImage { .. }
            | TargetEvent::CursorHidden => {
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
        // Source-over: anything else blanks the rest of the display.
        assert_eq!(parsed[0].1[1], "14");
        assert_eq!(parsed[0].1[3], "image/webp");
        assert_eq!(parsed[0].1[4], "16");
        assert_eq!(BASE64.decode(&parsed[1].1[1]).unwrap(), b"RIFFfake");
    }

    #[test]
    fn a_cursor_becomes_its_own_buffer_layer() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        encoder.encode(
            &TargetEvent::CursorImage {
                hotspot_x: 3,
                hotspot_y: 4,
                width: 32,
                height: 32,
                mimetype: "image/png",
                data: Bytes::from_static(b"PNGfake"),
            },
            &mut out,
        );
        let parsed = instructions(&out);
        assert_eq!(
            parsed.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>(),
            vec!["size", "img", "blob", "end", "cursor"]
        );
        // Buffer layers are negative, keeping the cursor off the display.
        assert_eq!(parsed[0].1[0], "-1");
        assert_eq!(parsed[1].1[2], "-1");
        // Replace, or a new shape stacks on top of the previous one.
        assert_eq!(parsed[1].1[1], "12");
        let cursor = &parsed[4].1;
        assert_eq!(cursor[0], "3");
        assert_eq!(cursor[1], "4");
        assert_eq!(cursor[2], "-1");
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
    fn a_clipboard_stream_is_spread_over_frames() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        let payload = Bytes::from(vec![0xABu8; MAX_BLOB_BYTES * 2 + 7]);
        encoder.encode_clipboard(&payload, &mut out);
        // `clipboard`, three `blob`s and `end`, each its own frame.
        assert_eq!(out.len(), 5);
    }

    #[test]
    fn audio_opens_one_stream_and_keeps_feeding_it() {
        // Re-announcing the stream per packet would restart the player's
        // timeline, and ending it would tear the buffer down between
        // sounds. Neither may happen while the session lives.
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        let packet = Bytes::from(vec![0x7Fu8; 64]);
        encoder.encode_audio(&packet, &mut out);
        encoder.encode_audio(&packet, &mut out);
        encoder.encode_audio(&packet, &mut out);

        let text: Vec<String> = out
            .iter()
            .map(|f| match f {
                ClientFrame::Text(b) => String::from_utf8_lossy(b).into_owned(),
                ClientFrame::Binary(_) => String::new(),
            })
            .collect();
        let joined = text.join("");
        assert_eq!(
            joined.matches("5.audio").count(),
            1,
            "the stream must be announced exactly once: {joined}"
        );
        assert_eq!(
            joined.matches("3.end").count(),
            0,
            "ending the stream would stop playback: {joined}"
        );
        assert_eq!(text.iter().filter(|t| t.contains("4.blob")).count(), 3);
    }

    #[test]
    fn a_long_wave_packet_is_split_into_blobs() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        let packet = Bytes::from(vec![0x11u8; MAX_BLOB_BYTES * 2 + 5]);
        encoder.encode_audio(&packet, &mut out);
        // One `audio` announcement plus three blobs.
        assert_eq!(out.len(), 4);
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

    #[test]
    fn video_slice_h264_emits_stream_instruction_and_blobs() {
        let mut encoder = GuacWireEncoder::new();
        let mut out = Vec::new();
        let nal_unit = Bytes::from_static(b"\x00\x00\x00\x01\x67\x42\x00\x1fNALPAYLOAD");
        encoder.encode(
            &TargetEvent::VideoSlice {
                codec: VideoCodec::H264,
                keyframe: true,
                timestamp_ms: 1000,
                data: nal_unit,
            },
            &mut out,
        );
        let parsed = instructions(&out);
        assert_eq!(parsed[0].0, "h264");
        assert_eq!(parsed[0].1[1], "0"); // layer
        assert_eq!(parsed[0].1[2], "1"); // keyframe
        assert_eq!(parsed[1].0, "blob");
        assert_eq!(parsed[2].0, "end");
    }
}
