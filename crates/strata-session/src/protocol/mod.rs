//! Guacamole wire protocol: framing, parsing and typed instructions.

pub mod guacamole;
pub mod instruction;

pub use guacamole::{encode_instruction, try_parse_instruction, GuacInstruction};
pub use instruction::{ClientInstruction, ServerInstruction};
