//! Buffered decoder turning a client byte stream into instructions.

use bytes::{Buf, BytesMut};

use crate::error::WireError;
use crate::protocol::guacamole::try_parse_instruction;
use crate::protocol::ClientInstruction;

/// Default ceiling on unparsed client bytes.
///
/// One instruction can legitimately be large (a clipboard paste), so the
/// limit is generous — but it is a limit: without one, a peer that sends
/// `9.` and then nothing forever grows the buffer without bound.
pub const DEFAULT_DECODE_LIMIT: usize = 16 * 1024 * 1024;

/// Accumulates client bytes and yields complete instructions.
#[derive(Debug)]
pub struct GuacDecoder {
    buf: BytesMut,
    limit: usize,
}

impl Default for GuacDecoder {
    fn default() -> Self {
        Self::new(DEFAULT_DECODE_LIMIT)
    }
}

impl GuacDecoder {
    /// Create a decoder that buffers at most `limit` unparsed bytes.
    #[must_use]
    pub fn new(limit: usize) -> Self {
        Self {
            buf: BytesMut::new(),
            limit,
        }
    }

    /// Append freshly read bytes.
    pub fn extend(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Bytes currently buffered but not yet parsed.
    #[must_use]
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// Pull the next complete instruction, if one is buffered.
    pub fn next_instruction(&mut self) -> Result<Option<ClientInstruction>, WireError> {
        let (decoded, consumed) = match try_parse_instruction(&self.buf)? {
            Some((raw, consumed)) => (ClientInstruction::from_wire(&raw)?, consumed),
            None => {
                if self.buf.len() > self.limit {
                    return Err(WireError::BufferOverflow { limit: self.limit });
                }
                return Ok(None);
            }
        };
        self.buf.advance(consumed);
        Ok(Some(decoded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_instructions_split_across_reads() {
        let mut decoder = GuacDecoder::default();
        decoder.extend(b"5.mou");
        assert_eq!(decoder.next_instruction().unwrap(), None);
        decoder.extend(b"se,3.512,3.384,1.1;3.n");
        assert_eq!(
            decoder.next_instruction().unwrap(),
            Some(ClientInstruction::Mouse {
                x: 512,
                y: 384,
                mask: 1
            })
        );
        assert_eq!(decoder.next_instruction().unwrap(), None);
        decoder.extend(b"op;");
        assert_eq!(
            decoder.next_instruction().unwrap(),
            Some(ClientInstruction::Nop)
        );
        assert_eq!(decoder.buffered(), 0);
    }

    #[test]
    fn decodes_several_instructions_from_one_read() {
        let mut decoder = GuacDecoder::default();
        decoder.extend(b"3.nop;4.sync,1.7;10.disconnect;");
        let mut seen = Vec::new();
        while let Some(instruction) = decoder.next_instruction().unwrap() {
            seen.push(instruction);
        }
        assert_eq!(
            seen,
            vec![
                ClientInstruction::Nop,
                ClientInstruction::Sync { timestamp: 7 },
                ClientInstruction::Disconnect,
            ]
        );
    }

    #[test]
    fn rejects_an_unterminated_flood() {
        let mut decoder = GuacDecoder::new(64);
        decoder.extend(b"999999.");
        decoder.extend(&[b'a'; 128]);
        assert_eq!(
            decoder.next_instruction().unwrap_err(),
            WireError::BufferOverflow { limit: 64 }
        );
    }

    #[test]
    fn surfaces_malformed_input_as_an_error() {
        let mut decoder = GuacDecoder::default();
        decoder.extend(b"nope;");
        assert_eq!(
            decoder.next_instruction().unwrap_err(),
            WireError::Malformed
        );
    }
}
