//! Zero-copy parser and encoder for the Guacamole text wire protocol.
//!
//! An instruction is a comma-separated list of length-prefixed elements
//! terminated by a semicolon:
//!
//! ```text
//!   5.mouse,3.512,3.384,1.1;
//! ```
//!
//! The length prefix counts **Unicode characters, not bytes** — a detail
//! that has bitten this codebase before, because a payload containing a
//! multi-byte glyph makes naive byte-slicing walk off the end of the
//! element. Parsing therefore walks UTF-8 leading bytes to convert the
//! character count into a byte offset.
//!
//! Parsing borrows directly from the caller's buffer: no allocation
//! happens per element, only the `Vec` holding the argument slices.
//!
//! Failure is split into two kinds, which the streaming decoder relies
//! on to tell "wait for more bytes" apart from "kill this connection":
//!
//! - [`winnow::error::ErrMode::Backtrack`] — the input is a valid but
//!   incomplete prefix of an instruction.
//! - [`winnow::error::ErrMode::Cut`] — the input can never become a
//!   valid instruction.

use bytes::{BufMut, BytesMut};
use winnow::error::{ContextError, ErrMode};
use winnow::token::{take, take_while};
use winnow::{ModalResult, Parser};

use crate::error::WireError;

/// Maximum number of elements (opcode included) in one instruction.
///
/// The widest instruction in the protocol is `img`/`blob` territory at
/// well under a dozen elements; 64 leaves generous headroom while
/// bounding the per-instruction `Vec`.
pub const MAX_INSTRUCTION_ELEMENTS: usize = 64;

/// Maximum characters in a single element. Sized for a full clipboard
/// blob, matching the 8 MiB ceiling the guacd deployment settled on.
pub const MAX_ELEMENT_CHARS: usize = 8 * 1024 * 1024;

/// Digits allowed in a length prefix. Nine digits caps a declared length
/// below `u32::MAX` so the parse can never overflow.
const MAX_LENGTH_DIGITS: usize = 9;

/// One parsed instruction, borrowing its text from the input buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuacInstruction<'a> {
    /// The instruction name — `mouse`, `key`, `img`, ...
    pub opcode: &'a str,
    /// Remaining elements, in wire order.
    pub args: Vec<&'a str>,
}

impl<'a> GuacInstruction<'a> {
    /// Build an instruction from an opcode and its arguments.
    #[must_use]
    pub fn new(opcode: &'a str, args: Vec<&'a str>) -> Self {
        Self { opcode, args }
    }

    /// Argument at `index`, or `None` when the instruction is shorter.
    #[must_use]
    pub fn arg(&self, index: usize) -> Option<&'a str> {
        self.args.get(index).copied()
    }

    /// Argument at `index` parsed as an integer.
    pub fn arg_int<T: std::str::FromStr>(&self, index: usize) -> Result<T, WireError> {
        self.arg(index)
            .ok_or(WireError::MissingArgument {
                opcode: self.opcode.to_owned(),
                index,
            })?
            .parse()
            .map_err(|_| WireError::BadArgument {
                opcode: self.opcode.to_owned(),
                index,
            })
    }

    /// Append this instruction to `out` in wire form.
    pub fn encode(&self, out: &mut BytesMut) {
        encode_instruction(out, self.opcode, &self.args);
    }
}

/// Encode `opcode` plus `args` as a single Guacamole instruction.
pub fn encode_instruction(out: &mut BytesMut, opcode: &str, args: &[&str]) {
    let total: usize = opcode.len() + args.iter().map(|a| a.len() + 12).sum::<usize>() + 12;
    out.reserve(total);
    push_element(out, opcode);
    for arg in args {
        out.put_u8(b',');
        push_element(out, arg);
    }
    out.put_u8(b';');
}

fn push_element(out: &mut BytesMut, value: &str) {
    let mut digits = itoa_buf();
    let len = write_usize(&mut digits, value.chars().count());
    out.put_slice(&digits[len..]);
    out.put_u8(b'.');
    out.put_slice(value.as_bytes());
}

/// Scratch space for base-10 rendering without pulling in a formatter.
const fn itoa_buf() -> [u8; 20] {
    [0u8; 20]
}

/// Render `value` into the tail of `buf`, returning the start offset.
fn write_usize(buf: &mut [u8; 20], mut value: usize) -> usize {
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            return i;
        }
    }
}

/// Parse one instruction from the front of `input`, advancing it past
/// the terminating `;`.
///
/// # Errors
///
/// Returns a backtrack error for an incomplete prefix and a cut error
/// for input that is structurally invalid.
pub fn parse_instruction<'a>(input: &mut &'a [u8]) -> ModalResult<GuacInstruction<'a>> {
    let opcode = parse_element(input)?;
    let mut args = Vec::new();
    loop {
        match input.first() {
            None => return Err(incomplete()),
            Some(b';') => {
                *input = &input[1..];
                return Ok(GuacInstruction { opcode, args });
            }
            Some(b',') => {
                if args.len() + 1 >= MAX_INSTRUCTION_ELEMENTS {
                    return Err(malformed());
                }
                *input = &input[1..];
                args.push(parse_element(input)?);
            }
            Some(_) => return Err(malformed()),
        }
    }
}

/// Parse a single `<length>.<value>` element.
fn parse_element<'a>(input: &mut &'a [u8]) -> ModalResult<&'a str> {
    match input.first() {
        None => return Err(incomplete()),
        Some(b) if !b.is_ascii_digit() => return Err(malformed()),
        Some(_) => {}
    }

    let digits: &[u8] = take_while(1..=MAX_LENGTH_DIGITS, |b: u8| b.is_ascii_digit())
        .parse_next(input)
        .map_err(|_: ErrMode<ContextError>| malformed())?;

    match input.first() {
        None => return Err(incomplete()),
        Some(b'.') => *input = &input[1..],
        Some(_) => return Err(malformed()),
    }

    let char_len = digits
        .iter()
        .fold(0usize, |acc, d| acc * 10 + usize::from(d - b'0'));
    if char_len > MAX_ELEMENT_CHARS {
        return Err(malformed());
    }

    let byte_len = match utf8_prefix_len(input, char_len) {
        Ok(Some(n)) => n,
        Ok(None) => return Err(incomplete()),
        Err(()) => return Err(malformed()),
    };

    let raw: &[u8] = take(byte_len)
        .parse_next(input)
        .map_err(|_: ErrMode<ContextError>| incomplete())?;
    std::str::from_utf8(raw).map_err(|_| malformed())
}

/// Byte length of the first `chars` UTF-8 characters of `input`.
///
/// `Ok(None)` means the buffer holds fewer than `chars` characters but
/// nothing seen so far is invalid — the caller should read more. `Err`
/// means the bytes are not well-formed UTF-8 and never will be.
fn utf8_prefix_len(input: &[u8], chars: usize) -> Result<Option<usize>, ()> {
    let mut idx = 0usize;
    for _ in 0..chars {
        let Some(&lead) = input.get(idx) else {
            return Ok(None);
        };
        let width = match lead {
            0x00..=0x7F => 1,
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            // Continuation byte in lead position, or an overlong /
            // out-of-range lead.
            _ => return Err(()),
        };
        if idx + width > input.len() {
            return Ok(None);
        }
        for cont in &input[idx + 1..idx + width] {
            if cont & 0xC0 != 0x80 {
                return Err(());
            }
        }
        idx += width;
    }
    Ok(Some(idx))
}

fn incomplete() -> ErrMode<ContextError> {
    ErrMode::Backtrack(ContextError::new())
}

fn malformed() -> ErrMode<ContextError> {
    ErrMode::Cut(ContextError::new())
}

/// Streaming-friendly wrapper around [`parse_instruction`].
///
/// Returns the instruction plus the number of bytes it consumed, or
/// `Ok(None)` when `buf` does not yet hold a complete instruction.
pub fn try_parse_instruction(
    buf: &[u8],
) -> Result<Option<(GuacInstruction<'_>, usize)>, WireError> {
    let mut input = buf;
    match parse_instruction(&mut input) {
        Ok(instruction) => Ok(Some((instruction, buf.len() - input.len()))),
        Err(ErrMode::Backtrack(_)) => Ok(None),
        Err(_) => Err(WireError::Malformed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(raw: &[u8]) -> GuacInstruction<'_> {
        let (instruction, consumed) = try_parse_instruction(raw).unwrap().unwrap();
        assert_eq!(consumed, raw.len(), "parser must consume the whole input");
        instruction
    }

    #[test]
    fn parses_an_opcode_only_instruction() {
        let instruction = parse_all(b"3.nop;");
        assert_eq!(instruction.opcode, "nop");
        assert!(instruction.args.is_empty());
    }

    #[test]
    fn parses_a_mouse_instruction() {
        let instruction = parse_all(b"5.mouse,3.512,3.384,1.1;");
        assert_eq!(instruction.opcode, "mouse");
        assert_eq!(instruction.args, vec!["512", "384", "1"]);
        assert_eq!(instruction.arg_int::<u32>(1).unwrap(), 384);
    }

    #[test]
    fn parses_a_zero_length_element() {
        let instruction = parse_all(b"3.msg,0.,4.body;");
        assert_eq!(instruction.args, vec!["", "body"]);
    }

    #[test]
    fn length_prefix_counts_characters_not_bytes() {
        // "café" is 4 characters but 5 bytes; a byte-counting parser
        // would slice mid-sequence and desynchronise the stream.
        let raw = "9.clipboard,4.café;".as_bytes();
        let instruction = parse_all(raw);
        assert_eq!(instruction.args, vec!["café"]);
    }

    #[test]
    fn payload_delimiters_are_not_mistaken_for_framing() {
        let raw = "9.clipboard,7.a,b;c,d;".as_bytes();
        let instruction = parse_all(raw);
        assert_eq!(instruction.args, vec!["a,b;c,d"]);
    }

    #[test]
    fn reports_trailing_bytes_after_one_instruction() {
        let raw = b"3.nop;5.mouse,1.0,1.0,1.0;";
        let (first, consumed) = try_parse_instruction(raw).unwrap().unwrap();
        assert_eq!(first.opcode, "nop");
        let (second, _) = try_parse_instruction(&raw[consumed..]).unwrap().unwrap();
        assert_eq!(second.opcode, "mouse");
    }

    #[test]
    fn every_prefix_of_a_valid_instruction_is_incomplete_not_invalid() {
        let raw = "9.clipboard,4.café;".as_bytes();
        for cut in 0..raw.len() {
            assert_eq!(
                try_parse_instruction(&raw[..cut]).unwrap(),
                None,
                "prefix of {cut} bytes must be reported incomplete"
            );
        }
    }

    #[test]
    fn rejects_structurally_invalid_input() {
        for raw in [
            &b"nop;"[..],                                      // no length prefix
            &b"3.nop!"[..],                                    // bad terminator
            &b"3.nop,"[..],        // separator then non-digit at EOF is incomplete
            &b"3,nop;"[..],        // comma instead of dot
            &b"9999999999.x;"[..], // length prefix too long
            &b"99999999.x;"[..],   // declared length beyond the cap
            &[0x35, 0x2e, 0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0x3b], // invalid UTF-8
        ] {
            let result = try_parse_instruction(raw);
            assert!(
                result.is_err() || result.unwrap().is_none(),
                "expected rejection for {raw:?}"
            );
        }
        assert!(try_parse_instruction(b"nop;").is_err());
        assert!(try_parse_instruction(b"3.nop!").is_err());
        assert!(try_parse_instruction(b"3,nop;").is_err());
    }

    #[test]
    fn refuses_an_absurd_element_count() {
        let mut raw = String::from("4.blob");
        for _ in 0..MAX_INSTRUCTION_ELEMENTS {
            raw.push_str(",1.x");
        }
        raw.push(';');
        assert!(try_parse_instruction(raw.as_bytes()).is_err());
    }

    #[test]
    fn encodes_using_character_lengths() {
        let mut out = BytesMut::new();
        encode_instruction(&mut out, "clipboard", &["café"]);
        assert_eq!(&out[..], "9.clipboard,4.café;".as_bytes());
    }

    #[test]
    fn encode_then_parse_round_trips() {
        let cases: Vec<(&str, Vec<&str>)> = vec![
            ("nop", vec![]),
            ("sync", vec!["1726000000"]),
            ("img", vec!["1", "12", "0", "image/png", "0", "0"]),
            ("clipboard", vec!["0", "text/plain"]),
            ("error", vec!["upstream unreachable ;,.", "519"]),
            ("blob", vec!["0", "iVBORw0KGgo="]),
        ];
        for (opcode, args) in cases {
            let mut out = BytesMut::new();
            encode_instruction(&mut out, opcode, &args);
            let parsed = parse_all(&out);
            assert_eq!(parsed.opcode, opcode);
            assert_eq!(parsed.args, args);
        }
    }

    #[test]
    fn never_panics_on_arbitrary_bytes() {
        let seeds: [&[u8]; 6] = [
            b"",
            b".",
            b"0.",
            b"1.\xf0",
            b"\xff\xff\xff",
            b"18.aaaaaaaaaaaaaaaaaa,",
        ];
        for seed in seeds {
            for extra in 0..=255u8 {
                let mut raw = seed.to_vec();
                raw.push(extra);
                let _ = try_parse_instruction(&raw);
            }
        }
    }
}
