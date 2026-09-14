//! Binary media envelope for **Native Direct Streaming Mode**.
//!
//! The legacy Guacamole wire is UTF-8 text: every graphical update has to
//! be rasterised server-side and re-encoded as PNG/WebP before it can be
//! framed. That double-encoding is the single largest CPU cost in the
//! session tier.
//!
//! This module defines the binary alternative. Compressed payloads taken
//! straight off the target protocol (H.264 NAL units from RDP EGFX, Opus
//! from the audio channel, raw PTY bytes from SSH) are wrapped in a fixed
//! 14-byte header and pushed to the browser, which feeds them into
//! `VideoDecoder` (WebCodecs) or `xterm.js` without the server ever
//! touching a pixel.
//!
//! ```text
//!   0        1          2                 10              14
//!   +--------+----------+-----------------+---------------+---------+
//!   | magic  | stream   | timestamp (u64) | length (u32)  | payload |
//!   | 0xAA   | type u8  | big-endian ms   | big-endian    | ...     |
//!   +--------+----------+-----------------+---------------+---------+
//! ```
//!
//! All multi-byte fields are big-endian so a JavaScript `DataView` can
//! read them with the default (non-little-endian) argument.

use bytes::{BufMut, BytesMut};

use crate::errors::ProtocolError;

/// First byte of every binary envelope. Lets a client that receives a
/// mixed text/binary WebSocket distinguish the two without buffering.
pub const MEDIA_MAGIC: u8 = 0xAA;

/// Size of the fixed header preceding every payload.
pub const MEDIA_HEADER_LEN: usize = 14;

/// Hard cap on a single envelope's payload. A 4K keyframe is well under
/// 4 MiB; anything past this is a bug or an attack, and we refuse it
/// rather than allocating on an attacker's say-so.
pub const MAX_MEDIA_PAYLOAD: usize = 16 * 1024 * 1024;

/// Kind of payload carried by a [`MediaEnvelope`].
///
/// Wire values are stable — the browser client switches on them — so new
/// variants must take the next free discriminant and never reuse one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum StreamType {
    /// H.264 Annex-B NAL units, lifted verbatim from the RDP EGFX channel.
    H264Video = 0x01,
    /// Opus audio packets.
    OpusAudio = 0x02,
    /// Raw PTY bytes (ANSI/VT100) destined for `xterm.js`.
    RawTerminal = 0x03,
    /// Clipboard synchronisation payload.
    ClipboardSync = 0x04,
}

impl StreamType {
    /// Wire discriminant.
    #[must_use]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    /// Parse a wire discriminant, rejecting unknown values.
    pub fn from_u8(value: u8) -> Result<Self, ProtocolError> {
        match value {
            0x01 => Ok(Self::H264Video),
            0x02 => Ok(Self::OpusAudio),
            0x03 => Ok(Self::RawTerminal),
            0x04 => Ok(Self::ClipboardSync),
            other => Err(ProtocolError::Malformed(format!(
                "unknown media stream type: 0x{other:02x}"
            ))),
        }
    }
}

/// A single framed media payload, borrowed from the surrounding buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaEnvelope<'a> {
    /// What the payload is.
    pub stream_type: StreamType,
    /// Capture time, milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    /// Compressed payload bytes, untouched by the server.
    pub payload: &'a [u8],
}

impl<'a> MediaEnvelope<'a> {
    /// Construct an envelope. Fails if the payload exceeds
    /// [`MAX_MEDIA_PAYLOAD`].
    pub fn new(
        stream_type: StreamType,
        timestamp_ms: u64,
        payload: &'a [u8],
    ) -> Result<Self, ProtocolError> {
        if payload.len() > MAX_MEDIA_PAYLOAD {
            return Err(ProtocolError::Malformed(format!(
                "media payload too large: {} > {MAX_MEDIA_PAYLOAD}",
                payload.len()
            )));
        }
        Ok(Self {
            stream_type,
            timestamp_ms,
            payload,
        })
    }

    /// Total encoded size, header included.
    #[must_use]
    pub fn encoded_len(&self) -> usize {
        MEDIA_HEADER_LEN + self.payload.len()
    }

    /// Append the encoded envelope to `out`.
    pub fn encode(&self, out: &mut BytesMut) {
        out.reserve(self.encoded_len());
        out.put_u8(MEDIA_MAGIC);
        out.put_u8(self.stream_type.as_u8());
        out.put_u64(self.timestamp_ms);
        // Checked in `new`; the cast cannot truncate.
        out.put_u32(self.payload.len() as u32);
        out.put_slice(self.payload);
    }

    /// Encode into a fresh buffer.
    #[must_use]
    pub fn to_bytes(&self) -> BytesMut {
        let mut out = BytesMut::with_capacity(self.encoded_len());
        self.encode(&mut out);
        out
    }

    /// Decode one envelope from the front of `buf`.
    ///
    /// Returns `Ok(None)` when `buf` holds a valid but incomplete prefix,
    /// so a stream reader can simply wait for more bytes. On success the
    /// envelope borrows from `buf` and the total consumed length is
    /// returned alongside it.
    pub fn decode(buf: &'a [u8]) -> Result<Option<(Self, usize)>, ProtocolError> {
        if buf.len() < MEDIA_HEADER_LEN {
            return Ok(None);
        }
        if buf[0] != MEDIA_MAGIC {
            return Err(ProtocolError::Malformed(format!(
                "bad media magic: 0x{:02x}",
                buf[0]
            )));
        }
        let stream_type = StreamType::from_u8(buf[1])?;
        let timestamp_ms = u64::from_be_bytes(
            buf[2..10]
                .try_into()
                .expect("slice of 8 bytes is always 8 bytes"),
        );
        let len = u32::from_be_bytes(
            buf[10..14]
                .try_into()
                .expect("slice of 4 bytes is always 4 bytes"),
        ) as usize;
        if len > MAX_MEDIA_PAYLOAD {
            return Err(ProtocolError::Malformed(format!(
                "declared media payload too large: {len} > {MAX_MEDIA_PAYLOAD}"
            )));
        }
        let end = MEDIA_HEADER_LEN + len;
        if buf.len() < end {
            return Ok(None);
        }
        Ok(Some((
            Self {
                stream_type,
                timestamp_ms,
                payload: &buf[MEDIA_HEADER_LEN..end],
            },
            end,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_video_slice() {
        let payload = b"\x00\x00\x00\x01\x65nal-unit-body";
        let env = MediaEnvelope::new(StreamType::H264Video, 1_726_000_000_123, payload).unwrap();
        let bytes = env.to_bytes();
        assert_eq!(bytes.len(), MEDIA_HEADER_LEN + payload.len());

        let (decoded, consumed) = MediaEnvelope::decode(&bytes).unwrap().unwrap();
        assert_eq!(consumed, bytes.len());
        assert_eq!(decoded, env);
    }

    #[test]
    fn decodes_back_to_back_envelopes() {
        let mut buf = BytesMut::new();
        MediaEnvelope::new(StreamType::RawTerminal, 1, b"hello")
            .unwrap()
            .encode(&mut buf);
        MediaEnvelope::new(StreamType::ClipboardSync, 2, b"world!")
            .unwrap()
            .encode(&mut buf);

        let (first, n) = MediaEnvelope::decode(&buf).unwrap().unwrap();
        assert_eq!(first.stream_type, StreamType::RawTerminal);
        assert_eq!(first.payload, b"hello");

        let (second, m) = MediaEnvelope::decode(&buf[n..]).unwrap().unwrap();
        assert_eq!(second.stream_type, StreamType::ClipboardSync);
        assert_eq!(second.timestamp_ms, 2);
        assert_eq!(n + m, buf.len());
    }

    #[test]
    fn partial_input_is_not_an_error() {
        let env = MediaEnvelope::new(StreamType::OpusAudio, 7, b"opus-packet").unwrap();
        let bytes = env.to_bytes();
        for cut in 0..bytes.len() {
            assert_eq!(
                MediaEnvelope::decode(&bytes[..cut]).unwrap(),
                None,
                "prefix of {cut} bytes should be incomplete, not decoded"
            );
        }
    }

    #[test]
    fn rejects_bad_magic_and_unknown_stream_type() {
        let mut bytes = MediaEnvelope::new(StreamType::H264Video, 0, b"x")
            .unwrap()
            .to_bytes();
        let good = bytes.clone();

        bytes[0] = 0xBB;
        assert!(MediaEnvelope::decode(&bytes).is_err());

        let mut bytes = good;
        bytes[1] = 0x7F;
        assert!(MediaEnvelope::decode(&bytes).is_err());
    }

    #[test]
    fn refuses_an_oversized_declared_length() {
        let mut bytes = MediaEnvelope::new(StreamType::H264Video, 0, b"x")
            .unwrap()
            .to_bytes();
        bytes[10..14].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(MediaEnvelope::decode(&bytes).is_err());
    }

    #[test]
    fn never_panics_on_arbitrary_bytes() {
        for len in 0..40usize {
            let junk: Vec<u8> = (0..len).map(|i| (i as u8).wrapping_mul(31)).collect();
            let _ = MediaEnvelope::decode(&junk);
        }
    }
}
