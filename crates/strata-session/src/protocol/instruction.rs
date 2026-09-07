//! Typed views over the Guacamole instruction set.
//!
//! [`guacamole`](super::guacamole) deals in borrowed string slices; this
//! module lifts the subset of instructions the session engine actually
//! acts on into enums, so the actor loop matches on meaning rather than
//! on opcode strings.

use bytes::BytesMut;

use crate::error::WireError;
use crate::protocol::guacamole::{encode_instruction, GuacInstruction};

/// An instruction sent by the browser client towards the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientInstruction {
    /// The client display was resized.
    Size {
        /// New width in pixels.
        width: u32,
        /// New height in pixels.
        height: u32,
    },
    /// Pointer moved or a button changed state.
    Mouse {
        /// X coordinate in pixels.
        x: i32,
        /// Y coordinate in pixels.
        y: i32,
        /// Button bitmask, as defined by the Guacamole protocol.
        mask: u8,
    },
    /// A key was pressed or released.
    Key {
        /// X11 keysym.
        keysym: u32,
        /// `true` for press, `false` for release.
        pressed: bool,
    },
    /// The client is opening a clipboard stream.
    Clipboard {
        /// Stream index.
        stream: i32,
        /// Declared mimetype, typically `text/plain`.
        mimetype: String,
    },
    /// A chunk of stream data (base64 encoded on the wire).
    Blob {
        /// Stream index.
        stream: i32,
        /// Base64 payload, left undecoded until the consumer needs it.
        data: String,
    },
    /// A stream is finished.
    End {
        /// Stream index.
        stream: i32,
    },
    /// Frame acknowledgement carrying the client's timestamp.
    Sync {
        /// Client timestamp in milliseconds.
        timestamp: i64,
    },
    /// Keep-alive.
    Nop,
    /// The client asked to end the session.
    Disconnect,
    /// An opcode this engine does not act on.
    Unhandled {
        /// The opcode as received.
        opcode: String,
    },
}

impl ClientInstruction {
    /// Interpret a parsed instruction.
    ///
    /// Unknown opcodes become [`ClientInstruction::Unhandled`] rather
    /// than an error: guacd tolerates them, and failing the session on
    /// an unrecognised opcode would be a compatibility regression.
    pub fn from_wire(instruction: &GuacInstruction<'_>) -> Result<Self, WireError> {
        Ok(match instruction.opcode {
            "size" => Self::Size {
                width: instruction.arg_int(0)?,
                height: instruction.arg_int(1)?,
            },
            "mouse" => Self::Mouse {
                x: instruction.arg_int(0)?,
                y: instruction.arg_int(1)?,
                mask: instruction.arg_int(2)?,
            },
            "key" => Self::Key {
                keysym: instruction.arg_int(0)?,
                pressed: instruction.arg_int::<u8>(1)? != 0,
            },
            "clipboard" => Self::Clipboard {
                stream: instruction.arg_int(0)?,
                mimetype: instruction
                    .arg(1)
                    .ok_or(WireError::MissingArgument {
                        opcode: "clipboard".to_owned(),
                        index: 1,
                    })?
                    .to_owned(),
            },
            "blob" => Self::Blob {
                stream: instruction.arg_int(0)?,
                data: instruction
                    .arg(1)
                    .ok_or(WireError::MissingArgument {
                        opcode: "blob".to_owned(),
                        index: 1,
                    })?
                    .to_owned(),
            },
            "end" => Self::End {
                stream: instruction.arg_int(0)?,
            },
            "sync" => Self::Sync {
                timestamp: instruction.arg_int(0)?,
            },
            "nop" => Self::Nop,
            "disconnect" => Self::Disconnect,
            other => Self::Unhandled {
                opcode: other.to_owned(),
            },
        })
    }
}

/// An instruction sent from the session engine towards the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerInstruction {
    /// Declare or resize a layer.
    Size {
        /// Layer index.
        layer: i32,
        /// Width in pixels.
        width: u32,
        /// Height in pixels.
        height: u32,
    },
    /// Set the current path to a rectangle.
    Rect {
        /// Layer index.
        layer: i32,
        /// Left edge.
        x: i32,
        /// Top edge.
        y: i32,
        /// Width in pixels.
        width: u32,
        /// Height in pixels.
        height: u32,
    },
    /// Fill the current path with a colour.
    Cfill {
        /// Porter-Duff compositing mode.
        mask: u8,
        /// Layer index.
        layer: i32,
        /// Red channel.
        r: u8,
        /// Green channel.
        g: u8,
        /// Blue channel.
        b: u8,
        /// Alpha channel.
        a: u8,
    },
    /// Open an image stream targeting a layer.
    Img {
        /// Stream index.
        stream: i32,
        /// Compositing mode.
        mask: u8,
        /// Layer index.
        layer: i32,
        /// Image mimetype, e.g. `image/webp`.
        mimetype: String,
        /// Destination X.
        x: i32,
        /// Destination Y.
        y: i32,
    },
    /// A chunk of stream data, base64 encoded.
    Blob {
        /// Stream index.
        stream: i32,
        /// Base64 payload.
        data: String,
    },
    /// Close a stream.
    End {
        /// Stream index.
        stream: i32,
    },
    /// Frame boundary carrying the server timestamp.
    Sync {
        /// Server timestamp in milliseconds.
        timestamp: i64,
    },
    /// Update the mouse cursor from a layer region.
    Cursor {
        /// Hotspot X.
        hotspot_x: i32,
        /// Hotspot Y.
        hotspot_y: i32,
        /// Source layer index.
        src_layer: i32,
        /// Source X.
        src_x: i32,
        /// Source Y.
        src_y: i32,
        /// Source width.
        src_width: u32,
        /// Source height.
        src_height: u32,
    },
    /// Human-readable notice for the client to display.
    Msg {
        /// Message code.
        code: i32,
        /// Message arguments.
        args: Vec<String>,
    },
    /// Fatal error; the client should disconnect.
    Error {
        /// Human-readable text.
        text: String,
        /// Guacamole status code.
        status: i32,
    },
    /// Clipboard stream heading to the client.
    Clipboard {
        /// Stream index.
        stream: i32,
        /// Declared mimetype.
        mimetype: String,
    },
    /// Audio stream heading to the client.
    Audio {
        /// Stream index.
        stream: i32,
        /// Declared mimetype, which must describe the samples exactly:
        /// the player takes the rate and channel count from here rather
        /// than from the data.
        mimetype: String,
    },
}

impl ServerInstruction {
    /// Append the wire form of this instruction to `out`.
    pub fn encode(&self, out: &mut BytesMut) {
        // Rendered integers must outlive the `&str` slice array below,
        // so each arm materialises its strings first.
        match self {
            Self::Size {
                layer,
                width,
                height,
            } => {
                let (a, b, c) = (layer.to_string(), width.to_string(), height.to_string());
                encode_instruction(out, "size", &[&a, &b, &c]);
            }
            Self::Rect {
                layer,
                x,
                y,
                width,
                height,
            } => {
                let v = [
                    layer.to_string(),
                    x.to_string(),
                    y.to_string(),
                    width.to_string(),
                    height.to_string(),
                ];
                encode_str_args(out, "rect", &v);
            }
            Self::Cfill {
                mask,
                layer,
                r,
                g,
                b,
                a,
            } => {
                let v = [
                    mask.to_string(),
                    layer.to_string(),
                    r.to_string(),
                    g.to_string(),
                    b.to_string(),
                    a.to_string(),
                ];
                encode_str_args(out, "cfill", &v);
            }
            Self::Img {
                stream,
                mask,
                layer,
                mimetype,
                x,
                y,
            } => {
                let v = [
                    stream.to_string(),
                    mask.to_string(),
                    layer.to_string(),
                    mimetype.clone(),
                    x.to_string(),
                    y.to_string(),
                ];
                encode_str_args(out, "img", &v);
            }
            Self::Blob { stream, data } => {
                let v = [stream.to_string(), data.clone()];
                encode_str_args(out, "blob", &v);
            }
            Self::End { stream } => {
                let v = [stream.to_string()];
                encode_str_args(out, "end", &v);
            }
            Self::Sync { timestamp } => {
                let v = [timestamp.to_string()];
                encode_str_args(out, "sync", &v);
            }
            Self::Cursor {
                hotspot_x,
                hotspot_y,
                src_layer,
                src_x,
                src_y,
                src_width,
                src_height,
            } => {
                let v = [
                    hotspot_x.to_string(),
                    hotspot_y.to_string(),
                    src_layer.to_string(),
                    src_x.to_string(),
                    src_y.to_string(),
                    src_width.to_string(),
                    src_height.to_string(),
                ];
                encode_str_args(out, "cursor", &v);
            }
            Self::Msg { code, args } => {
                let mut v = Vec::with_capacity(args.len() + 1);
                v.push(code.to_string());
                v.extend(args.iter().cloned());
                encode_str_args(out, "msg", &v);
            }
            Self::Error { text, status } => {
                let v = [text.clone(), status.to_string()];
                encode_str_args(out, "error", &v);
            }
            Self::Clipboard { stream, mimetype } => {
                let v = [stream.to_string(), mimetype.clone()];
                encode_str_args(out, "clipboard", &v);
            }
            Self::Audio { stream, mimetype } => {
                let v = [stream.to_string(), mimetype.clone()];
                encode_str_args(out, "audio", &v);
            }
        }
    }

    /// Encode into a fresh buffer.
    #[must_use]
    pub fn to_bytes(&self) -> BytesMut {
        let mut out = BytesMut::new();
        self.encode(&mut out);
        out
    }
}

fn encode_str_args(out: &mut BytesMut, opcode: &str, args: &[String]) {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    encode_instruction(out, opcode, &refs);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::guacamole::try_parse_instruction;

    fn wire(raw: &[u8]) -> ClientInstruction {
        let (instruction, _) = try_parse_instruction(raw).unwrap().unwrap();
        ClientInstruction::from_wire(&instruction).unwrap()
    }

    #[test]
    fn decodes_pointer_and_key_events() {
        assert_eq!(
            wire(b"5.mouse,3.512,3.384,1.1;"),
            ClientInstruction::Mouse {
                x: 512,
                y: 384,
                mask: 1
            }
        );
        assert_eq!(
            wire(b"3.key,5.65307,1.0;"),
            ClientInstruction::Key {
                keysym: 65307,
                pressed: false
            }
        );
    }

    #[test]
    fn decodes_resize_and_sync() {
        assert_eq!(
            wire(b"4.size,4.1920,4.1080;"),
            ClientInstruction::Size {
                width: 1920,
                height: 1080
            }
        );
        assert_eq!(
            wire(b"4.sync,10.1726000000;"),
            ClientInstruction::Sync {
                timestamp: 1_726_000_000
            }
        );
    }

    #[test]
    fn unknown_opcodes_are_tolerated() {
        assert_eq!(
            wire(b"5.audio,1.0;"),
            ClientInstruction::Unhandled {
                opcode: "audio".to_owned()
            }
        );
    }

    #[test]
    fn short_instructions_are_rejected_with_context() {
        let (instruction, _) = try_parse_instruction(b"5.mouse,3.512;").unwrap().unwrap();
        let err = ClientInstruction::from_wire(&instruction).unwrap_err();
        assert_eq!(
            err,
            WireError::MissingArgument {
                opcode: "mouse".to_owned(),
                index: 1
            }
        );
    }

    #[test]
    fn non_numeric_arguments_are_rejected() {
        let (instruction, _) = try_parse_instruction(b"5.mouse,1.x,1.0,1.0;")
            .unwrap()
            .unwrap();
        assert_eq!(
            ClientInstruction::from_wire(&instruction).unwrap_err(),
            WireError::BadArgument {
                opcode: "mouse".to_owned(),
                index: 0
            }
        );
    }

    #[test]
    fn server_instructions_match_the_guacd_wire_form() {
        assert_eq!(
            &ServerInstruction::Size {
                layer: 0,
                width: 1024,
                height: 768
            }
            .to_bytes()[..],
            b"4.size,1.0,4.1024,3.768;"
        );
        assert_eq!(
            &ServerInstruction::Sync {
                timestamp: 1_726_000_000
            }
            .to_bytes()[..],
            b"4.sync,10.1726000000;"
        );
        assert_eq!(
            &ServerInstruction::Img {
                stream: 1,
                mask: 12,
                layer: 0,
                mimetype: "image/png".to_owned(),
                x: 0,
                y: 0
            }
            .to_bytes()[..],
            b"3.img,1.1,2.12,1.0,9.image/png,1.0,1.0;"
        );
    }

    #[test]
    fn error_text_containing_delimiters_survives_a_round_trip() {
        let instruction = ServerInstruction::Error {
            text: "target said: no; try again, later.".to_owned(),
            status: 519,
        };
        let bytes = instruction.to_bytes();
        let (parsed, consumed) = try_parse_instruction(&bytes).unwrap().unwrap();
        assert_eq!(consumed, bytes.len());
        assert_eq!(parsed.opcode, "error");
        assert_eq!(parsed.arg(0).unwrap(), "target said: no; try again, later.");
    }
}
