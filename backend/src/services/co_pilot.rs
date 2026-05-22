//! # Co-pilot multiplayer-share protocol envelope
//!
//! Wire format for the multiplayer / co-pilot extension to the existing
//! `GET /api/shared/tunnel/:share_token` WebSocket. Frames are
//! distinguishable from Guacamole opcode frames by their leading `{`
//! character (Guacamole frames are length-prefixed like `4.sync,…`).
//!
//! This module is *protocol-only*: it defines the types, their JSON
//! serialisation, and the validation rules. No I/O, no broadcast, no
//! state — those live in the (forthcoming) `co_pilot::room` module.
//!
//! See `docs/roadmap.md` → *Multiplayer / Co-Pilot Mode* and the
//! implementation-plan attached to the v1.9.6 milestone.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod room;

pub use room::{CoPilotRoom, InputClaimResult, JoinError};

/// Maximum length of a participant-supplied display name, in bytes.
pub const MAX_DISPLAY_NAME_LEN: usize = 40;

/// Maximum length of a chat message, in bytes (UTF-8).
pub const MAX_CHAT_LEN: usize = 500;

/// Maximum length of a server-assigned colour token (e.g. `#aabbccdd`).
pub const MAX_COLOR_LEN: usize = 9;

/// Maximum length of an SDP blob in WebRTC signalling messages.
pub const MAX_SDP_LEN: usize = 8192;

/// Maximum length of an ICE candidate string.
pub const MAX_ICE_CANDIDATE_LEN: usize = 1024;

/// Maximum length of an [`CoPilotMsg::InputRevoke`] reason string.
pub const MAX_REVOKE_REASON_LEN: usize = 120;

/// Current co-pilot protocol version. Bumped on any breaking wire
/// change so the client can refuse to handshake.
pub const PROTOCOL_VERSION: u16 = 1;

/// Hard server-side cap on participants per co-pilot room — matches
/// the practical limit of a WebRTC audio mesh.
pub const MAX_PARTICIPANTS: u8 = 6;

/// Errors returned by [`CoPilotMsg::validate`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)] // every variant describes a `field` validation failure; the prefix is intentional.
pub enum CoPilotError {
    /// A bounded string field exceeded its limit.
    #[error("field `{field}` exceeds maximum length ({max} bytes)")]
    FieldTooLong {
        /// Name of the offending field.
        field: &'static str,
        /// Configured maximum length in bytes.
        max: usize,
    },

    /// A required string field was empty.
    #[error("field `{field}` must not be empty")]
    FieldEmpty {
        /// Name of the offending field.
        field: &'static str,
    },

    /// A string field contained control characters that would corrupt
    /// the Guacamole framing or render badly in the UI.
    #[error("field `{field}` contains forbidden control characters")]
    FieldHasControlChars {
        /// Name of the offending field.
        field: &'static str,
    },
}

/// A single roster entry — server-authoritative view of one
/// participant currently joined to the co-pilot room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RosterEntry {
    /// Server-assigned per-WS participant id (ephemeral).
    pub pid: Uuid,
    /// Sanitised display name (≤ [`MAX_DISPLAY_NAME_LEN`] bytes).
    pub display_name: String,
    /// Server-assigned colour token (`#rrggbb` or `#rrggbbaa`).
    pub color: String,
    /// `true` iff this participant currently holds the input token.
    pub has_input: bool,
    /// `true` iff this participant is the session owner.
    pub is_owner: bool,
}

/// Multiplayer envelope exchanged over the shared-tunnel WebSocket.
///
/// Frames are serialised as JSON with an external `type` tag so they
/// can be distinguished from Guacamole opcode frames (which begin
/// with a digit length prefix) by their leading `{` character.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CoPilotMsg {
    /// Client → server, first frame after WS open. Server replies
    /// with a [`CoPilotMsg::Roster`] once it has assigned the pid.
    Hello {
        /// Participant-supplied display name. Server will sanitise +
        /// truncate to [`MAX_DISPLAY_NAME_LEN`] bytes and disambiguate
        /// collisions (`Alex`, `Alex (2)`).
        display_name: String,
        /// Whether the joining participant wants to opt into the
        /// optional WebRTC audio mesh.
        #[serde(default)]
        want_audio: bool,
        /// Client-advertised protocol version. Defaults to `1` for
        /// older clients that omit it.
        #[serde(default = "default_protocol_version")]
        protocol_version: u16,
    },

    /// Server → single client, sent immediately after a successful
    /// `Hello` join. Carries the participant's server-assigned `pid`
    /// (the client cannot derive it from `Roster` alone) plus the
    /// room policy flags so the UI can decide whether to render chat
    /// or audio controls.
    Welcome {
        /// Server-assigned participant id for this WebSocket.
        pid: Uuid,
        /// Whether the room exposes a chat channel.
        allow_chat: bool,
        /// Whether the room signals an optional WebRTC audio mesh.
        allow_audio: bool,
        /// DB-clamped participant cap (1..=6) for this share.
        max_participants: u8,
    },

    /// Server → all, broadcast on every join / leave / input-grant.
    Roster {
        /// Current room membership in stable join order.
        participants: Vec<RosterEntry>,
    },

    /// Any → fan-out. Coordinates are in display (canvas) space,
    /// pre-scaling — the renderer translates per its own zoom level.
    Cursor {
        /// Originating participant.
        pid: Uuid,
        /// Display-space X.
        x: i32,
        /// Display-space Y.
        y: i32,
        /// Client-side capture timestamp (ms since epoch). Server
        /// stamps its own clock onto the fan-out copy via [`Self::Chat`]-style relay.
        ts: u64,
    },

    /// Any → fan-out + audit-counter. Chat content is **never
    /// persisted** beyond the per-room ring buffer.
    Chat {
        /// Originating participant.
        pid: Uuid,
        /// UTF-8 message body, ≤ [`MAX_CHAT_LEN`] bytes.
        text: String,
        /// Server-stamped fan-out timestamp (ms since epoch). On the
        /// inbound (client → server) frame this is ignored.
        ts: u64,
    },

    /// Client → server. Requests the input token. Server arbitrates
    /// per the room's policy (first-claim after idle, or owner force-grant).
    InputClaim {
        /// Originating participant.
        pid: Uuid,
    },

    /// Client → server. Voluntarily releases the input token.
    InputRelease {
        /// Originating participant.
        pid: Uuid,
    },

    /// Server → all, on every successful claim.
    InputGrant {
        /// Participant that now holds the token.
        pid: Uuid,
        /// Pid that authorised the grant (owner, or `Uuid::nil()` for
        /// the server's auto-grant after idle).
        by: Uuid,
    },

    /// Owner or server → all. Wipes the current input holder.
    InputRevoke {
        /// Pid that issued the revoke (owner pid, or `Uuid::nil()` for server).
        by: Uuid,
        /// Short human-readable reason (≤ [`MAX_REVOKE_REASON_LEN`] bytes).
        reason: String,
    },

    /// WebRTC signalling — server relays verbatim between named pids,
    /// never inspects SDP.
    AudioOffer {
        /// Originating participant.
        pid: Uuid,
        /// Destination participant.
        to: Uuid,
        /// SDP offer blob.
        sdp: String,
    },

    /// WebRTC signalling — answer.
    AudioAnswer {
        /// Originating participant.
        pid: Uuid,
        /// Destination participant.
        to: Uuid,
        /// SDP answer blob.
        sdp: String,
    },

    /// WebRTC signalling — trickled ICE candidate.
    Ice {
        /// Originating participant.
        pid: Uuid,
        /// Destination participant.
        to: Uuid,
        /// SDP-encoded ICE candidate line.
        candidate: String,
    },

    /// Server → all, when a participant disconnects.
    Leave {
        /// Departing participant.
        pid: Uuid,
    },
}

fn default_protocol_version() -> u16 {
    1
}

impl CoPilotMsg {
    /// Validate the bounded-string invariants on this envelope. Called
    /// on every inbound frame *before* fan-out so that limits are
    /// enforced at the trust boundary.
    pub fn validate(&self) -> Result<(), CoPilotError> {
        match self {
            Self::Hello { display_name, .. } => {
                check_nonempty("display_name", display_name)?;
                check_len("display_name", display_name, MAX_DISPLAY_NAME_LEN)?;
                check_no_control("display_name", display_name)?;
            }
            Self::Roster { participants } => {
                for p in participants {
                    check_nonempty("display_name", &p.display_name)?;
                    check_len("display_name", &p.display_name, MAX_DISPLAY_NAME_LEN)?;
                    check_len("color", &p.color, MAX_COLOR_LEN)?;
                }
            }
            Self::Welcome { .. } => {}
            Self::Cursor { .. } => {}
            Self::Chat { text, .. } => {
                check_nonempty("text", text)?;
                check_len("text", text, MAX_CHAT_LEN)?;
                // chat is rendered as plain text, but reject NUL/BEL/etc.
                check_no_control_except_newline("text", text)?;
            }
            Self::InputClaim { .. } | Self::InputRelease { .. } | Self::InputGrant { .. } => {}
            Self::InputRevoke { reason, .. } => {
                check_len("reason", reason, MAX_REVOKE_REASON_LEN)?;
                check_no_control("reason", reason)?;
            }
            Self::AudioOffer { sdp, .. } | Self::AudioAnswer { sdp, .. } => {
                check_nonempty("sdp", sdp)?;
                check_len("sdp", sdp, MAX_SDP_LEN)?;
            }
            Self::Ice { candidate, .. } => {
                check_nonempty("candidate", candidate)?;
                check_len("candidate", candidate, MAX_ICE_CANDIDATE_LEN)?;
            }
            Self::Leave { .. } => {}
        }
        Ok(())
    }

    /// Returns `true` iff the first byte of `frame` indicates a JSON
    /// envelope rather than a Guacamole opcode. Cheap inline check so
    /// the WS hot path can branch without a full parse attempt.
    #[inline]
    pub fn looks_like_envelope(frame: &str) -> bool {
        frame.as_bytes().first().copied() == Some(b'{')
    }
}

fn check_nonempty(field: &'static str, s: &str) -> Result<(), CoPilotError> {
    if s.is_empty() {
        Err(CoPilotError::FieldEmpty { field })
    } else {
        Ok(())
    }
}

fn check_len(field: &'static str, s: &str, max: usize) -> Result<(), CoPilotError> {
    if s.len() > max {
        Err(CoPilotError::FieldTooLong { field, max })
    } else {
        Ok(())
    }
}

fn check_no_control(field: &'static str, s: &str) -> Result<(), CoPilotError> {
    if s.chars().any(|c| c.is_control()) {
        Err(CoPilotError::FieldHasControlChars { field })
    } else {
        Ok(())
    }
}

fn check_no_control_except_newline(field: &'static str, s: &str) -> Result<(), CoPilotError> {
    if s.chars().any(|c| c.is_control() && c != '\n' && c != '\r') {
        Err(CoPilotError::FieldHasControlChars { field })
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pid() -> Uuid {
        Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap()
    }

    fn other_pid() -> Uuid {
        Uuid::parse_str("00000000-0000-4000-8000-000000000002").unwrap()
    }

    #[test]
    fn hello_round_trip() {
        let m = CoPilotMsg::Hello {
            display_name: "Alex".into(),
            want_audio: true,
            protocol_version: 1,
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains("\"type\":\"hello\""));
        let parsed: CoPilotMsg = serde_json::from_str(&s).unwrap();
        assert_eq!(m, parsed);
    }

    #[test]
    fn hello_defaults_protocol_version_when_missing() {
        let parsed: CoPilotMsg =
            serde_json::from_str(r#"{"type":"hello","display_name":"Alex"}"#).unwrap();
        match parsed {
            CoPilotMsg::Hello {
                protocol_version,
                want_audio,
                ..
            } => {
                assert_eq!(protocol_version, 1);
                assert!(!want_audio);
            }
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn roster_round_trip() {
        let m = CoPilotMsg::Roster {
            participants: vec![
                RosterEntry {
                    pid: pid(),
                    display_name: "Alex".into(),
                    color: "#aabbcc".into(),
                    has_input: true,
                    is_owner: true,
                },
                RosterEntry {
                    pid: other_pid(),
                    display_name: "Sam".into(),
                    color: "#112233".into(),
                    has_input: false,
                    is_owner: false,
                },
            ],
        };
        let s = serde_json::to_string(&m).unwrap();
        let parsed: CoPilotMsg = serde_json::from_str(&s).unwrap();
        assert_eq!(m, parsed);
    }

    #[test]
    fn cursor_round_trip() {
        let m = CoPilotMsg::Cursor {
            pid: pid(),
            x: 100,
            y: -42,
            ts: 1_700_000_000_000,
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains("\"type\":\"cursor\""));
        let parsed: CoPilotMsg = serde_json::from_str(&s).unwrap();
        assert_eq!(m, parsed);
    }

    #[test]
    fn input_grant_round_trip() {
        let m = CoPilotMsg::InputGrant {
            pid: pid(),
            by: Uuid::nil(),
        };
        let s = serde_json::to_string(&m).unwrap();
        let parsed: CoPilotMsg = serde_json::from_str(&s).unwrap();
        assert_eq!(m, parsed);
    }

    #[test]
    fn validate_rejects_empty_display_name() {
        let m = CoPilotMsg::Hello {
            display_name: "".into(),
            want_audio: false,
            protocol_version: 1,
        };
        assert_eq!(
            m.validate(),
            Err(CoPilotError::FieldEmpty {
                field: "display_name"
            })
        );
    }

    #[test]
    fn validate_rejects_overlong_display_name() {
        let m = CoPilotMsg::Hello {
            display_name: "a".repeat(MAX_DISPLAY_NAME_LEN + 1),
            want_audio: false,
            protocol_version: 1,
        };
        assert_eq!(
            m.validate(),
            Err(CoPilotError::FieldTooLong {
                field: "display_name",
                max: MAX_DISPLAY_NAME_LEN,
            })
        );
    }

    #[test]
    fn validate_rejects_control_chars_in_display_name() {
        let m = CoPilotMsg::Hello {
            display_name: "Al\nex".into(),
            want_audio: false,
            protocol_version: 1,
        };
        assert_eq!(
            m.validate(),
            Err(CoPilotError::FieldHasControlChars {
                field: "display_name"
            })
        );
    }

    #[test]
    fn validate_accepts_newlines_in_chat() {
        let m = CoPilotMsg::Chat {
            pid: pid(),
            text: "line one\nline two".into(),
            ts: 0,
        };
        assert!(m.validate().is_ok());
    }

    #[test]
    fn validate_rejects_nul_in_chat() {
        let m = CoPilotMsg::Chat {
            pid: pid(),
            text: "evil\0string".into(),
            ts: 0,
        };
        assert_eq!(
            m.validate(),
            Err(CoPilotError::FieldHasControlChars { field: "text" })
        );
    }

    #[test]
    fn validate_rejects_overlong_chat() {
        let m = CoPilotMsg::Chat {
            pid: pid(),
            text: "x".repeat(MAX_CHAT_LEN + 1),
            ts: 0,
        };
        assert_eq!(
            m.validate(),
            Err(CoPilotError::FieldTooLong {
                field: "text",
                max: MAX_CHAT_LEN
            })
        );
    }

    #[test]
    fn validate_rejects_empty_chat() {
        let m = CoPilotMsg::Chat {
            pid: pid(),
            text: "".into(),
            ts: 0,
        };
        assert_eq!(
            m.validate(),
            Err(CoPilotError::FieldEmpty { field: "text" })
        );
    }

    #[test]
    fn validate_rejects_overlong_sdp() {
        let m = CoPilotMsg::AudioOffer {
            pid: pid(),
            to: other_pid(),
            sdp: "v=0\r\n".repeat(MAX_SDP_LEN), // way too big
        };
        assert!(matches!(
            m.validate(),
            Err(CoPilotError::FieldTooLong { field: "sdp", .. })
        ));
    }

    #[test]
    fn validate_rejects_overlong_ice_candidate() {
        let m = CoPilotMsg::Ice {
            pid: pid(),
            to: other_pid(),
            candidate: "a".repeat(MAX_ICE_CANDIDATE_LEN + 1),
        };
        assert!(matches!(
            m.validate(),
            Err(CoPilotError::FieldTooLong {
                field: "candidate",
                ..
            })
        ));
    }

    #[test]
    fn looks_like_envelope_distinguishes_json_from_guacamole() {
        assert!(CoPilotMsg::looks_like_envelope("{\"type\":\"cursor\"}"));
        assert!(!CoPilotMsg::looks_like_envelope("4.sync,13.1700000000000;"));
        assert!(!CoPilotMsg::looks_like_envelope(""));
    }

    #[test]
    fn unknown_type_fails_to_parse() {
        let r: Result<CoPilotMsg, _> = serde_json::from_str(r#"{"type":"nonexistent"}"#);
        assert!(r.is_err());
    }

    #[test]
    fn snake_case_type_tags_are_stable() {
        // Locking the wire format — these strings must not change
        // without a PROTOCOL_VERSION bump.
        let pairs = [
            (
                CoPilotMsg::Hello {
                    display_name: "a".into(),
                    want_audio: false,
                    protocol_version: 1,
                },
                "hello",
            ),
            (CoPilotMsg::InputClaim { pid: pid() }, "input_claim"),
            (CoPilotMsg::InputRelease { pid: pid() }, "input_release"),
            (
                CoPilotMsg::InputGrant {
                    pid: pid(),
                    by: Uuid::nil(),
                },
                "input_grant",
            ),
            (
                CoPilotMsg::InputRevoke {
                    by: Uuid::nil(),
                    reason: "test".into(),
                },
                "input_revoke",
            ),
            (CoPilotMsg::Leave { pid: pid() }, "leave"),
            (
                CoPilotMsg::AudioOffer {
                    pid: pid(),
                    to: other_pid(),
                    sdp: "v=0".into(),
                },
                "audio_offer",
            ),
            (
                CoPilotMsg::AudioAnswer {
                    pid: pid(),
                    to: other_pid(),
                    sdp: "v=0".into(),
                },
                "audio_answer",
            ),
            (
                CoPilotMsg::Ice {
                    pid: pid(),
                    to: other_pid(),
                    candidate: "candidate:1".into(),
                },
                "ice",
            ),
        ];
        for (msg, tag) in pairs {
            let s = serde_json::to_string(&msg).unwrap();
            assert!(
                s.contains(&format!("\"type\":\"{tag}\"")),
                "expected `type:{tag}` in {s}"
            );
        }
    }

    #[test]
    fn protocol_version_constant_matches_default() {
        assert_eq!(PROTOCOL_VERSION, default_protocol_version());
    }
}
