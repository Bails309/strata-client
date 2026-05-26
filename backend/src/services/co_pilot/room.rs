//! Co-pilot multiplayer room — per-session shared state.
//!
//! Each [`ActiveSession`](crate::services::session_registry::ActiveSession)
//! owns one [`CoPilotRoom`]. The room tracks the live roster of
//! participants attached to the session's shared tunnel(s), arbitrates
//! the single-holder *input token*, and provides a JSON fan-out
//! channel that every participant WS subscribes to.
//!
//! All synchronous critical sections — no [`tokio`] await points are
//! held while the inner [`RwLock`] is locked, so a [`std::sync::RwLock`]
//! is preferred over the async equivalent for the hot path.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::broadcast;
use uuid::Uuid;

use super::{RosterEntry, MAX_DISPLAY_NAME_LEN, MAX_PARTICIPANTS};

/// Server-side fan-out channel capacity for envelope JSON strings.
const FANOUT_CAPACITY: usize = 1024;

/// After this much inactivity from the current input holder, a fresh
/// [`InputClaim`](super::CoPilotMsg::InputClaim) from any other
/// participant is granted automatically.
const INPUT_IDLE_GRANT_AFTER: Duration = Duration::from_secs(2);

/// Palette used to assign deterministic-but-distinct colours to joining
/// participants. Allocation is round-robin through the unused slots,
/// so the first six participants always pick six different colours.
const COLOR_PALETTE: &[&str] = &[
    "#3b82f6", // blue
    "#10b981", // emerald
    "#f59e0b", // amber
    "#ef4444", // red
    "#8b5cf6", // violet
    "#ec4899", // pink
    "#14b8a6", // teal
    "#f97316", // orange
];

/// One live participant in a co-pilot room.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Participant {
    /// Server-assigned, per-WS, ephemeral id.
    pub pid: Uuid,
    /// Sanitised display name (≤ [`MAX_DISPLAY_NAME_LEN`] bytes,
    /// suffix-disambiguated against the current roster).
    pub display_name: String,
    /// Server-assigned colour token from [`COLOR_PALETTE`].
    pub color: String,
    /// `true` iff this participant is the session's owner.
    pub is_owner: bool,
    /// Wall-clock join time.
    #[allow(dead_code)] // surfaced by the deferred owner participant-view endpoint.
    pub joined_at: Instant,
}

/// Outcome of a [`CoPilotRoom::try_claim_input`] call.
#[derive(Debug, PartialEq, Eq)]
pub enum InputClaimResult {
    /// Token has been transferred to the requesting pid.
    /// Carries the pid that previously held it (if any).
    Granted { previous: Option<Uuid> },
    /// Claim was denied — the current holder is still actively typing.
    /// Carries the current holder.
    Denied { current_holder: Uuid },
    /// The requesting pid already holds the token. No-op.
    AlreadyHeld,
    /// The requesting pid is not in the room.
    UnknownParticipant,
}

/// Outcome of a [`CoPilotRoom::join`] call.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum JoinError {
    /// The room already contains [`MAX_PARTICIPANTS`] members.
    #[error("room is full ({MAX_PARTICIPANTS} participants)")]
    RoomFull,
    /// Display name was empty after sanitisation.
    #[error("display name was empty after sanitisation")]
    EmptyDisplayName,
}

/// Per-session multiplayer-share room.
pub struct CoPilotRoom {
    /// Owning session id (matches `ActiveSession.session_id`). Kept for
    /// log correlation only — never mutated.
    #[allow(dead_code)] // surfaced through tracing spans on future audit work.
    pub session_id: String,
    state: RwLock<RoomState>,
    /// Server → all participants fan-out for JSON envelope strings.
    /// Subscribed to by every participant WS once they have joined.
    pub fanout_tx: broadcast::Sender<Arc<String>>,
}

#[derive(Debug)]
struct RoomState {
    participants: HashMap<Uuid, Participant>,
    /// Stable join order — drives the roster wire format so reconnecting
    /// clients see a consistent layout.
    join_order: Vec<Uuid>,
    input_holder: Option<Uuid>,
    input_last_activity: Instant,
}

impl CoPilotRoom {
    /// Create a fresh empty room. Cheap — no participants, no I/O.
    pub fn new(session_id: String) -> Arc<Self> {
        let (fanout_tx, _) = broadcast::channel(FANOUT_CAPACITY);
        Arc::new(Self {
            session_id,
            state: RwLock::new(RoomState {
                participants: HashMap::new(),
                join_order: Vec::new(),
                input_holder: None,
                input_last_activity: Instant::now(),
            }),
            fanout_tx,
        })
    }

    /// Admit a new participant. Sanitises `display_name`, allocates a
    /// colour, and (for non-owners) ensures the room has not exceeded
    /// [`MAX_PARTICIPANTS`]. The session owner is always admitted even
    /// when the room is "full" — they are the host.
    pub fn join(&self, display_name: &str, is_owner: bool) -> Result<Participant, JoinError> {
        let mut state = self.state.write().expect("co-pilot room lock poisoned");

        // Owner can always (re-)join even at cap — they're the host.
        if !is_owner && state.participants.len() >= MAX_PARTICIPANTS as usize {
            return Err(JoinError::RoomFull);
        }

        let cleaned = sanitise_display_name(display_name);
        if cleaned.is_empty() {
            return Err(JoinError::EmptyDisplayName);
        }

        // Disambiguate against the current roster.
        let used_names: HashSet<&str> = state
            .participants
            .values()
            .map(|p| p.display_name.as_str())
            .collect();
        let final_name = disambiguate(&cleaned, &used_names);

        // Round-robin colour allocation.
        let used_colors: HashSet<&str> = state
            .participants
            .values()
            .map(|p| p.color.as_str())
            .collect();
        let color = pick_color(&used_colors, state.participants.len());

        let pid = Uuid::new_v4();
        let participant = Participant {
            pid,
            display_name: final_name,
            color,
            is_owner,
            joined_at: Instant::now(),
        };

        // The owner implicitly starts with the input token if no one
        // else holds it.
        if is_owner && state.input_holder.is_none() {
            state.input_holder = Some(pid);
            state.input_last_activity = Instant::now();
        }

        state.participants.insert(pid, participant.clone());
        state.join_order.push(pid);
        Ok(participant)
    }

    /// Remove a participant. If they held the input token, the token
    /// is cleared (or transferred to the owner if present).
    /// Returns `true` iff a participant was actually removed.
    pub fn leave(&self, pid: Uuid) -> bool {
        let mut state = self.state.write().expect("co-pilot room lock poisoned");
        let removed = state.participants.remove(&pid).is_some();
        if removed {
            state.join_order.retain(|p| *p != pid);
            if state.input_holder == Some(pid) {
                // Auto-transfer to the owner if they're still present;
                // otherwise clear the token.
                let owner_pid = state
                    .participants
                    .values()
                    .find(|p| p.is_owner)
                    .map(|p| p.pid);
                state.input_holder = owner_pid;
                state.input_last_activity = Instant::now();
            }
        }
        removed
    }

    /// Roster snapshot in stable join order.
    pub fn roster(&self) -> Vec<RosterEntry> {
        let state = self.state.read().expect("co-pilot room lock poisoned");
        state
            .join_order
            .iter()
            .filter_map(|pid| state.participants.get(pid).map(|p| (pid, p)))
            .map(|(pid, p)| RosterEntry {
                pid: *pid,
                display_name: p.display_name.clone(),
                color: p.color.clone(),
                has_input: state.input_holder == Some(*pid),
                is_owner: p.is_owner,
            })
            .collect()
    }

    /// Current input-token holder, if any.
    #[allow(dead_code)] // exposed for the deferred owner participant-view endpoint.
    pub fn current_holder(&self) -> Option<Uuid> {
        self.state
            .read()
            .expect("co-pilot room lock poisoned")
            .input_holder
    }

    /// Returns `true` iff `pid` is in the room.
    #[allow(dead_code)] // exposed for the deferred owner participant-view endpoint.
    pub fn contains(&self, pid: Uuid) -> bool {
        self.state
            .read()
            .expect("co-pilot room lock poisoned")
            .participants
            .contains_key(&pid)
    }

    /// Returns `true` iff `pid` is the room's owner.
    #[allow(dead_code)] // exposed for the deferred owner participant-view endpoint.
    pub fn is_owner(&self, pid: Uuid) -> bool {
        self.state
            .read()
            .expect("co-pilot room lock poisoned")
            .participants
            .get(&pid)
            .map(|p| p.is_owner)
            .unwrap_or(false)
    }

    /// Participant count.
    #[allow(dead_code)] // exposed for the deferred owner participant-view endpoint.
    pub fn participant_count(&self) -> usize {
        self.state
            .read()
            .expect("co-pilot room lock poisoned")
            .participants
            .len()
    }

    /// Attempt to claim the input token for `pid`.
    ///
    /// Granted if:
    /// - The pid is the room owner (force-grant); or
    /// - No-one currently holds the token; or
    /// - The current holder has been idle for [`INPUT_IDLE_GRANT_AFTER`].
    pub fn try_claim_input(&self, pid: Uuid) -> InputClaimResult {
        let mut state = self.state.write().expect("co-pilot room lock poisoned");
        let p = match state.participants.get(&pid) {
            Some(p) => p.clone(),
            None => return InputClaimResult::UnknownParticipant,
        };
        match state.input_holder {
            Some(current) if current == pid => InputClaimResult::AlreadyHeld,
            Some(current)
                if !p.is_owner && state.input_last_activity.elapsed() < INPUT_IDLE_GRANT_AFTER =>
            {
                InputClaimResult::Denied {
                    current_holder: current,
                }
            }
            other => {
                state.input_holder = Some(pid);
                state.input_last_activity = Instant::now();
                InputClaimResult::Granted { previous: other }
            }
        }
    }

    /// Voluntary release. Returns `true` iff `pid` was the holder.
    pub fn release_input(&self, pid: Uuid) -> bool {
        let mut state = self.state.write().expect("co-pilot room lock poisoned");
        if state.input_holder == Some(pid) {
            state.input_holder = None;
            state.input_last_activity = Instant::now();
            true
        } else {
            false
        }
    }

    /// Owner force-revoke. Returns the previous holder, if any.
    /// The caller is responsible for validating that `by` is the owner.
    #[allow(dead_code)] // exposed for the deferred owner force-revoke endpoint.
    pub fn revoke_input(&self) -> Option<Uuid> {
        let mut state = self.state.write().expect("co-pilot room lock poisoned");
        let prev = state.input_holder.take();
        state.input_last_activity = Instant::now();
        prev
    }

    /// Owner force-grant to a specific participant. Returns the
    /// previous holder, if any, on success. Caller validates `by`.
    pub fn force_grant(&self, to: Uuid) -> Result<Option<Uuid>, JoinError> {
        let mut state = self.state.write().expect("co-pilot room lock poisoned");
        if !state.participants.contains_key(&to) {
            return Err(JoinError::EmptyDisplayName); // reuse: unknown target
        }
        let prev = state.input_holder.replace(to);
        state.input_last_activity = Instant::now();
        Ok(prev)
    }

    /// Bump the input-activity timer if `pid` currently holds the
    /// token. Returns `true` iff `pid` is the active holder (and thus
    /// the caller should forward this input frame to the session).
    pub fn note_input_activity(&self, pid: Uuid) -> bool {
        let mut state = self.state.write().expect("co-pilot room lock poisoned");
        if state.input_holder == Some(pid) {
            state.input_last_activity = Instant::now();
            true
        } else {
            false
        }
    }

    /// Subscribe to the room's envelope fan-out. Every participant's
    /// WebSocket loop holds one receiver; outbound envelopes are
    /// JSON-serialised once at the call site and shared via `Arc`.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<String>> {
        self.fanout_tx.subscribe()
    }

    /// Serialise `msg` once and fan it out to all participants. Returns
    /// the number of currently-subscribed receivers, or `0` if either
    /// serialisation failed or there are no listeners. We intentionally
    /// swallow serialisation errors here because the envelope was just
    /// constructed in-process from typed data — a failure would indicate
    /// a coding bug rather than a runtime condition worth propagating
    /// through the WebSocket loop.
    pub fn broadcast(&self, msg: &super::CoPilotMsg) -> usize {
        let json = match serde_json::to_string(msg) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "co-pilot envelope serialise failed");
                return 0;
            }
        };
        self.fanout_tx.send(Arc::new(json)).unwrap_or(0)
    }
}

/// Strip control characters, collapse whitespace, and truncate to
/// [`MAX_DISPLAY_NAME_LEN`] bytes on a UTF-8 char boundary.
fn sanitise_display_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_DISPLAY_NAME_LEN));
    let mut prev_was_ws = false;
    for c in raw.chars() {
        // Whitespace (including \n, \t, \r — which also count as
        // control chars) is collapsed to a single ASCII space; other
        // control chars are dropped outright. Order matters: checking
        // is_control first would swallow \n with no replacement.
        if c.is_whitespace() {
            if prev_was_ws || out.is_empty() {
                continue;
            }
            prev_was_ws = true;
            out.push(' ');
        } else if c.is_control() {
            continue;
        } else {
            prev_was_ws = false;
            out.push(c);
        }
        // Stop accumulating once we'd exceed the cap with the next
        // char — we may end one char short, that's fine.
        if out.len() >= MAX_DISPLAY_NAME_LEN {
            break;
        }
    }
    // Drop trailing collapsed whitespace.
    while out.ends_with(' ') {
        out.pop();
    }
    // If we crossed the cap with a multibyte char, trim back to the
    // last char boundary that fits.
    while out.len() > MAX_DISPLAY_NAME_LEN {
        out.pop();
    }
    out
}

/// Append ` (n)` suffix until the name is unique within `used`.
fn disambiguate(base: &str, used: &HashSet<&str>) -> String {
    if !used.contains(base) {
        return base.to_string();
    }
    for n in 2..=99 {
        let candidate = format!("{base} ({n})");
        if !used.contains(candidate.as_str()) {
            return candidate;
        }
    }
    // Last resort: append a short random tag. With MAX_PARTICIPANTS
    // = 6 this branch is unreachable in practice.
    format!("{base} ({})", &Uuid::new_v4().to_string()[..8])
}

/// Pick the first colour in [`COLOR_PALETTE`] that isn't already taken.
/// Falls back to the index modulo the palette length if all are taken
/// (impossible given [`MAX_PARTICIPANTS`] ≤ palette length).
fn pick_color(used: &HashSet<&str>, index: usize) -> String {
    COLOR_PALETTE
        .iter()
        .find(|c| !used.contains(**c))
        .copied()
        .unwrap_or(COLOR_PALETTE[index % COLOR_PALETTE.len()])
        .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_assigns_unique_colors_and_disambiguates_names() {
        let room = CoPilotRoom::new("s1".into());
        let a = room.join("Alex", true).unwrap();
        let b = room.join("Alex", false).unwrap();
        let c = room.join("Alex", false).unwrap();
        assert_eq!(a.display_name, "Alex");
        assert_eq!(b.display_name, "Alex (2)");
        assert_eq!(c.display_name, "Alex (3)");
        assert_ne!(a.color, b.color);
        assert_ne!(b.color, c.color);
        assert_ne!(a.color, c.color);
    }

    #[test]
    fn sanitise_strips_control_chars_and_collapses_whitespace() {
        assert_eq!(sanitise_display_name("  Al\nex  \tBot  "), "Al ex Bot");
        assert_eq!(sanitise_display_name("\0\0"), "");
        assert_eq!(sanitise_display_name(""), "");
    }

    #[test]
    fn sanitise_truncates_to_max_len_on_char_boundary() {
        let long = "ä".repeat(MAX_DISPLAY_NAME_LEN); // 2 bytes per char
        let out = sanitise_display_name(&long);
        assert!(out.len() <= MAX_DISPLAY_NAME_LEN);
        assert!(out.chars().all(|c| c == 'ä'));
    }

    #[test]
    fn join_rejects_empty_display_name() {
        let room = CoPilotRoom::new("s1".into());
        assert_eq!(room.join("   ", false), Err(JoinError::EmptyDisplayName));
        assert_eq!(room.join("\0\0", false), Err(JoinError::EmptyDisplayName));
    }

    #[test]
    fn join_enforces_room_cap_but_admits_owner() {
        let room = CoPilotRoom::new("s1".into());
        for i in 0..MAX_PARTICIPANTS {
            room.join(&format!("v{i}"), false).unwrap();
        }
        assert_eq!(room.participant_count(), MAX_PARTICIPANTS as usize);
        // Next non-owner is rejected.
        assert_eq!(
            room.join("v-extra", false).unwrap_err(),
            JoinError::RoomFull
        );
        // Owner is still admitted.
        let owner = room.join("Host", true).unwrap();
        assert!(owner.is_owner);
        assert_eq!(room.participant_count(), MAX_PARTICIPANTS as usize + 1);
    }

    #[test]
    fn owner_implicitly_holds_input_token() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        assert_eq!(room.current_holder(), Some(owner.pid));
        let viewer = room.join("Viewer", false).unwrap();
        // Owner still holds it after viewer joins.
        assert_eq!(room.current_holder(), Some(owner.pid));
        // Viewer claim is denied while owner is "active".
        match room.try_claim_input(viewer.pid) {
            InputClaimResult::Denied { current_holder } => {
                assert_eq!(current_holder, owner.pid)
            }
            other => panic!("expected Denied, got {other:?}"),
        }
    }

    #[test]
    fn idle_owner_loses_token_to_viewer_claim() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        let viewer = room.join("Viewer", false).unwrap();
        // Backdate the holder's last-activity past the idle threshold.
        {
            let mut state = room.state.write().unwrap();
            state.input_last_activity =
                Instant::now() - (INPUT_IDLE_GRANT_AFTER + Duration::from_millis(50));
        }
        match room.try_claim_input(viewer.pid) {
            InputClaimResult::Granted { previous } => {
                assert_eq!(previous, Some(owner.pid))
            }
            other => panic!("expected Granted, got {other:?}"),
        }
        assert_eq!(room.current_holder(), Some(viewer.pid));
    }

    #[test]
    fn owner_force_claim_bypasses_idle_threshold() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        let viewer = room.join("Viewer", false).unwrap();
        // Viewer takes the token after idle period.
        {
            let mut state = room.state.write().unwrap();
            state.input_last_activity =
                Instant::now() - (INPUT_IDLE_GRANT_AFTER + Duration::from_millis(50));
        }
        room.try_claim_input(viewer.pid);
        assert_eq!(room.current_holder(), Some(viewer.pid));
        // Owner immediately re-claims (within the idle window) — must succeed.
        match room.try_claim_input(owner.pid) {
            InputClaimResult::Granted { previous } => {
                assert_eq!(previous, Some(viewer.pid))
            }
            other => panic!("expected Granted, got {other:?}"),
        }
    }

    #[test]
    fn already_held_is_idempotent() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        assert_eq!(
            room.try_claim_input(owner.pid),
            InputClaimResult::AlreadyHeld
        );
    }

    #[test]
    fn unknown_participant_cannot_claim() {
        let room = CoPilotRoom::new("s1".into());
        room.join("Host", true).unwrap();
        let ghost = Uuid::new_v4();
        assert_eq!(
            room.try_claim_input(ghost),
            InputClaimResult::UnknownParticipant
        );
    }

    #[test]
    fn release_input_only_works_for_holder() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        let viewer = room.join("Viewer", false).unwrap();
        // Viewer doesn't hold — release is a no-op.
        assert!(!room.release_input(viewer.pid));
        // Owner does — release succeeds and clears the token.
        assert!(room.release_input(owner.pid));
        assert_eq!(room.current_holder(), None);
    }

    #[test]
    fn revoke_clears_holder() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        assert_eq!(room.revoke_input(), Some(owner.pid));
        assert_eq!(room.current_holder(), None);
    }

    #[test]
    fn force_grant_to_unknown_pid_is_rejected() {
        let room = CoPilotRoom::new("s1".into());
        room.join("Host", true).unwrap();
        let ghost = Uuid::new_v4();
        assert!(room.force_grant(ghost).is_err());
    }

    #[test]
    fn leave_transfers_token_to_owner_when_viewer_held_it() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        let viewer = room.join("Viewer", false).unwrap();
        room.force_grant(viewer.pid).unwrap();
        assert_eq!(room.current_holder(), Some(viewer.pid));
        assert!(room.leave(viewer.pid));
        assert_eq!(room.current_holder(), Some(owner.pid));
        assert_eq!(room.participant_count(), 1);
    }

    #[test]
    fn leave_clears_token_when_owner_absent() {
        let room = CoPilotRoom::new("s1".into());
        let viewer = room.join("Viewer", false).unwrap();
        // Force-grant directly to viewer (no owner present).
        room.force_grant(viewer.pid).unwrap();
        assert!(room.leave(viewer.pid));
        assert_eq!(room.current_holder(), None);
    }

    #[test]
    fn leave_unknown_pid_is_noop() {
        let room = CoPilotRoom::new("s1".into());
        assert!(!room.leave(Uuid::new_v4()));
    }

    #[test]
    fn roster_is_in_stable_join_order() {
        let room = CoPilotRoom::new("s1".into());
        let a = room.join("A", true).unwrap();
        let b = room.join("B", false).unwrap();
        let c = room.join("C", false).unwrap();
        let roster = room.roster();
        assert_eq!(
            roster.iter().map(|r| r.pid).collect::<Vec<_>>(),
            vec![a.pid, b.pid, c.pid]
        );
        assert!(roster[0].is_owner);
        assert!(roster[0].has_input);
        assert!(!roster[1].has_input);
        assert!(!roster[2].has_input);
    }

    #[test]
    fn note_input_activity_only_bumps_for_holder() {
        let room = CoPilotRoom::new("s1".into());
        let owner = room.join("Host", true).unwrap();
        let viewer = room.join("Viewer", false).unwrap();
        assert!(room.note_input_activity(owner.pid));
        assert!(!room.note_input_activity(viewer.pid));
    }

    #[test]
    fn disambiguate_helper_terminates_within_98_tries() {
        let mut used: HashSet<String> = HashSet::new();
        used.insert("Bot".into());
        for n in 2..=99 {
            used.insert(format!("Bot ({n})"));
        }
        let used_refs: HashSet<&str> = used.iter().map(String::as_str).collect();
        let out = disambiguate("Bot", &used_refs);
        // After 99 collisions we fall through to the uuid suffix branch.
        assert!(out.starts_with("Bot ("));
        assert!(!used.contains(&out));
    }

    #[test]
    fn pick_color_falls_back_when_palette_exhausted() {
        let all: HashSet<&str> = COLOR_PALETTE.iter().copied().collect();
        let fallback = pick_color(&all, 0);
        assert!(COLOR_PALETTE.contains(&fallback.as_str()));
    }
}
