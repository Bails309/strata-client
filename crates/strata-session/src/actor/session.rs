//! The session actor: one Tokio task per live connection.
//!
//! Replaces guacd's thread-per-connection / `fork()` model. Everything
//! that used to require shared C client structs — observers joining a
//! session, dual-control moderation, recording — is expressed here as
//! message passing, so there is no lock to contend on and no shared
//! mutable state to race.
//!
//! ```text
//!   client input ──► SessionActor ──► ProtocolEngine ──► target
//!                         │
//!                         ├──► client writer  (the operator's screen)
//!                         ├──► broadcast tap  (live observers)
//!                         └──► audit sink     (tamper-evident recording)
//! ```

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bytes::{Bytes, BytesMut};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::actor::audit::{AuditRecord, AuditSink};
use crate::engine::{
    DisconnectCause, FileEvent, FileRequest, InputEvent, ProtocolEngine, TargetEvent,
};
use crate::error::{EngineError, SessionError};
use crate::protocol::guacamole::encode_instruction;
use crate::protocol::ClientInstruction;
use crate::transport::{ClientFrame, FrameEncoder};

/// Frames buffered towards the operator before backpressure kicks in.
pub const CLIENT_QUEUE_DEPTH: usize = 256;

/// Frames retained for observers that fall behind.
///
/// An observer lagging past this window is disconnected rather than
/// allowed to hold memory for the whole session — observation must never
/// degrade the primary operator's stream.
pub const OBSERVER_QUEUE_DEPTH: usize = 128;

const SYNC_INTERVAL: Duration = Duration::from_secs(5);

/// Longest any one teardown step may take, so a stalled disk or target
/// cannot keep the others from running.
const TEARDOWN_STEP: Duration = Duration::from_secs(10);

/// How long to wait for a failed engine to say why it closed.
const CLOSE_REASON_GRACE: Duration = Duration::from_secs(1);

/// Largest clipboard payload accepted from the client.
pub const MAX_CLIPBOARD_BYTES: usize = 8 * 1024 * 1024;

/// Clipboard streams a client may have open at once (SEC-15). The browser
/// sends one at a time; the rest is headroom.
pub const MAX_CLIPBOARD_STREAMS: usize = 4;

/// Bytes all of a session's open clipboard streams may hold between them.
pub const MAX_CLIPBOARD_SESSION_BYTES: usize = 2 * MAX_CLIPBOARD_BYTES;

/// Upload streams a client may have open at once. The SFTP engine runs at
/// most 8 transfers and refuses the rest, which frees their ids here.
pub const MAX_UPLOAD_STREAMS: usize = 16;

/// A clipboard stream with no `blob` for this long is abandoned.
const CLIPBOARD_IDLE: Duration = Duration::from_secs(30);

/// A client clipboard stream still being received.
struct PendingClipboard {
    data: Vec<u8>,
    touched: Instant,
}

/// A frame as it left the session, shared with observers and the audit
/// sink.
#[derive(Debug, Clone)]
pub struct SessionFrame {
    /// Monotonic sequence number.
    pub seq: u64,
    /// Wall-clock time in milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    /// The encoded frame.
    pub frame: ClientFrame,
}

/// Verdict from a dual-control moderator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Moderation {
    /// Forward the input to the target.
    Allow,
    /// Drop the input and tell the operator why.
    Deny {
        /// Reason surfaced to the operator.
        reason: String,
    },
}

/// Reviews operator input before it reaches the target.
///
/// Used for dual-control policies: an approver's decision gates
/// keystrokes without the primary input path ever blocking on a lock.
pub trait InputModerator: Send + Sync + 'static {
    /// Decide whether `input` may proceed.
    fn review(&self, input: &InputEvent) -> Moderation;
}

/// Releases a checked-out credential when the session ends.
///
/// Implemented by the backend against `vaultrs`; the session tier only
/// knows that something must be revoked on teardown, never how.
#[async_trait]
pub trait CredentialGuard: Send + 'static {
    /// Revoke or schedule rotation of the session's credential.
    async fn revoke(&mut self) -> Result<(), SessionError>;
}

/// Messages accepted by a running session.
#[derive(Debug)]
pub enum SessionCommand {
    /// An instruction decoded from the operator's socket.
    ClientInput(ClientInstruction),
    /// Attach a live observer; the receiver is returned on the oneshot.
    AttachObserver(oneshot::Sender<broadcast::Receiver<SessionFrame>>),
    /// End the session.
    Terminate {
        /// Reason recorded in the audit log.
        reason: String,
    },
}

/// Handle to a running session actor.
#[derive(Debug, Clone)]
pub struct SessionHandle {
    id: String,
    commands: mpsc::Sender<SessionCommand>,
}

impl SessionHandle {
    /// The session identifier.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Deliver a client instruction.
    pub async fn send(&self, instruction: ClientInstruction) -> Result<(), SessionError> {
        self.commands
            .send(SessionCommand::ClientInput(instruction))
            .await
            .map_err(|_| SessionError::PipelineClosed("session actor"))
    }

    /// Attach a read-only observer to the live frame stream.
    pub async fn observe(&self) -> Result<broadcast::Receiver<SessionFrame>, SessionError> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(SessionCommand::AttachObserver(tx))
            .await
            .map_err(|_| SessionError::PipelineClosed("session actor"))?;
        rx.await
            .map_err(|_| SessionError::PipelineClosed("session actor"))
    }

    /// Ask the session to shut down.
    pub async fn terminate(&self, reason: impl Into<String>) -> Result<(), SessionError> {
        self.commands
            .send(SessionCommand::Terminate {
                reason: reason.into(),
            })
            .await
            .map_err(|_| SessionError::PipelineClosed("session actor"))
    }

    /// Resolves once the actor has finished tearing down, recording
    /// finalised included.
    pub async fn closed(&self) {
        self.commands.closed().await;
    }
}

/// What the session recording is required to contain.
///
/// The native actor records what it sends the client, so it already
/// omits mouse and touch. These two are the settings that would
/// otherwise leave the recording differing from what was authorised.
#[derive(Debug, Default, Clone, Copy)]
pub struct RecordingPolicy {
    /// Keep graphical output out of the recording.
    pub exclude_output: bool,
    /// Record the operator's keystrokes.
    pub include_keys: bool,
}

/// Everything a [`SessionActor`] needs to run.
pub struct SessionConfig {
    /// Session identifier, used in logs and audit records.
    pub id: String,
    /// The connected protocol engine.
    pub engine: Box<dyn ProtocolEngine>,
    /// Downstream encoder for the negotiated streaming mode.
    pub encoder: Box<dyn FrameEncoder>,
    /// Where the session recording goes.
    pub audit: Box<dyn AuditSink>,
    /// What that recording must contain.
    pub recording: RecordingPolicy,
    /// Optional dual-control gate on operator input.
    pub moderator: Option<Box<dyn InputModerator>>,
    /// Optional credential to revoke on teardown.
    pub credential: Option<Box<dyn CredentialGuard>>,
}

/// Owns one target connection and fans its output out to consumers.
pub struct SessionActor {
    id: String,
    engine: Box<dyn ProtocolEngine>,
    encoder: Box<dyn FrameEncoder>,
    audit: Box<dyn AuditSink>,
    recording: RecordingPolicy,
    moderator: Option<Box<dyn InputModerator>>,
    credential: Option<Box<dyn CredentialGuard>>,
    commands: mpsc::Receiver<SessionCommand>,
    to_client: mpsc::Sender<ClientFrame>,
    observers: broadcast::Sender<SessionFrame>,
    seq: u64,
    dropped_frames: u64,
    /// Partially received client clipboard streams, keyed by stream index.
    clipboard_streams: HashMap<i32, PendingClipboard>,
    /// Stream indices the client opened with `put`, so a `blob` on one
    /// is routed to the filesystem rather than to the clipboard.
    upload_streams: HashSet<i32>,
}

/// Whether an event paints something.
///
/// `recording-exclude-output` turns on for a reason — a screen showing
/// data the recording was not authorised to keep — so anything that puts
/// pixels on the canvas counts, including the cursor and the layer
/// geometry that would otherwise leak the desktop's shape.
fn is_graphical_output(event: &TargetEvent) -> bool {
    match event {
        TargetEvent::ImageUpdate { .. }
        | TargetEvent::VideoSlice { .. }
        | TargetEvent::TerminalOutput(_)
        | TargetEvent::CopyRegion { .. }
        | TargetEvent::Resized { .. }
        | TargetEvent::CursorImage { .. }
        | TargetEvent::CursorHidden => true,
        // Not pixels: audio has its own exclusion, and the rest is
        // session bookkeeping the recording needs to stay readable. A
        // file transfer is emphatically not screen content — it is the
        // part of a session an auditor most wants kept.
        TargetEvent::Audio(_)
        | TargetEvent::Clipboard(_)
        | TargetEvent::File(_)
        | TargetEvent::Disconnected { .. } => false,
    }
}

impl SessionActor {
    /// Spawn the actor, returning a handle and the operator's frame
    /// stream.
    #[must_use]
    pub fn spawn(config: SessionConfig) -> (SessionHandle, mpsc::Receiver<ClientFrame>) {
        let (command_tx, command_rx) = mpsc::channel(CLIENT_QUEUE_DEPTH);
        let (frame_tx, frame_rx) = mpsc::channel(CLIENT_QUEUE_DEPTH);
        let (observers, _) = broadcast::channel(OBSERVER_QUEUE_DEPTH);

        let handle = SessionHandle {
            id: config.id.clone(),
            commands: command_tx,
        };

        let actor = Self {
            id: config.id,
            engine: config.engine,
            encoder: config.encoder,
            audit: config.audit,
            recording: config.recording,
            moderator: config.moderator,
            credential: config.credential,
            commands: command_rx,
            to_client: frame_tx,
            observers,
            seq: 0,
            dropped_frames: 0,
            clipboard_streams: HashMap::new(),
            upload_streams: HashSet::new(),
        };

        tokio::spawn(async move {
            let id = actor.id.clone();
            if let Err(err) = actor.run().await {
                tracing::warn!(session = %id, error = %err, "session ended with an error");
            }
        });

        (handle, frame_rx)
    }

    async fn run(mut self) -> Result<(), SessionError> {
        let mut sync_interval = tokio::time::interval(SYNC_INTERVAL);
        sync_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        sync_interval.tick().await;

        let reason = loop {
            tokio::select! {
                command = self.commands.recv() => {
                    match command {
                        Some(SessionCommand::ClientInput(instruction)) => {
                            match self.on_client_input(instruction).await {
                                Ok(Some(reason)) => break reason,
                                Ok(None) => {}
                                Err(SessionError::Engine(err)) => {
                                    break self.end_after_input_failure(err).await;
                                }
                                Err(err) => break self.end_after_failure(err).await,
                            }
                        }
                        Some(SessionCommand::AttachObserver(reply)) => {
                            // A dropped receiver just means the observer
                            // gave up between asking and being answered.
                            let _ = reply.send(self.observers.subscribe());
                            tracing::info!(session = %self.id, "observer attached");
                        }
                        Some(SessionCommand::Terminate { reason }) => break reason,
                        None => break "client disconnected".to_owned(),
                    }
                }
                _ = sync_interval.tick() => {
                    // The checkpoint bounds how much of the recording a
                    // crash can lose to one sync interval.
                    let step = match self.emit_sync().await {
                        Ok(()) => self.audit.checkpoint().await,
                        Err(err) => Err(err),
                    };
                    if let Err(err) = step {
                        break self.end_after_failure(err).await;
                    }
                }
                event = self.engine.next_event() => {
                    match event {
                        Ok(Some(event)) => {
                            let disconnect = matches!(event, TargetEvent::Disconnected { .. });
                            if let Err(err) = self.on_target_event(event).await {
                                break self.end_after_failure(err).await;
                            }
                            if disconnect {
                                break "target disconnected".to_owned();
                            }
                        }
                        Ok(None) => {
                            self.notify_end(
                                "The remote session has ended.".to_owned(),
                                DisconnectCause::Ended,
                            )
                            .await;
                            break "target closed the stream".to_owned();
                        }
                        Err(err) => {
                            tracing::warn!(session = %self.id, error = %err, "engine failure");
                            let (reason, cause) = describe_engine_failure(&err);
                            self.notify_end(reason, cause).await;
                            break format!("engine failure: {err}");
                        }
                    }
                }
            }
        };

        self.teardown(&reason).await
    }

    /// Tell the client why the session is ending, best effort.
    async fn notify_end(&mut self, reason: String, cause: DisconnectCause) {
        let _ = self
            .on_target_event(TargetEvent::Disconnected { reason, cause })
            .await;
    }

    /// Wind down after a step of the session failed.
    async fn end_after_failure(&mut self, err: SessionError) -> String {
        if let SessionError::Audit(why) = &err {
            tracing::error!(session = %self.id, error = %why, "recording failed; ending the session");
            // Not via `emit`: that records first, and recording is what failed.
            let mut frames = Vec::new();
            self.encoder.encode(
                &TargetEvent::Disconnected {
                    reason: "The session recording failed, so the session was closed.".to_owned(),
                    cause: DisconnectCause::Failed,
                },
                &mut frames,
            );
            for frame in frames {
                let _ = self.to_client.try_send(frame);
            }
        }
        err.to_string()
    }

    /// Wind down after the engine refused input.
    ///
    /// An engine that has closed has usually queued the reason it closed,
    /// which says far more than the failed write does.
    async fn end_after_input_failure(&mut self, err: EngineError) -> String {
        if let Ok(Ok(Some(event @ TargetEvent::Disconnected { .. }))) =
            tokio::time::timeout(CLOSE_REASON_GRACE, self.engine.next_event()).await
        {
            let _ = self.on_target_event(event).await;
            return "target disconnected".to_owned();
        }
        tracing::warn!(session = %self.id, error = %err, "engine failure on input");
        let (reason, cause) = describe_engine_failure(&err);
        self.notify_end(reason, cause).await;
        format!("engine failure: {err}")
    }

    /// Returns `Some(reason)` when the session should end.
    async fn on_client_input(
        &mut self,
        instruction: ClientInstruction,
    ) -> Result<Option<String>, SessionError> {
        let input = match instruction {
            ClientInstruction::Mouse { x, y, mask } => InputEvent::Mouse { x, y, mask },
            ClientInstruction::Key { keysym, pressed } => InputEvent::Key { keysym, pressed },
            ClientInstruction::Size { width, height, dpi } => {
                InputEvent::Resize { width, height, dpi }
            }
            ClientInstruction::Disconnect => return Ok(Some("client requested disconnect".into())),
            ClientInstruction::Clipboard { stream, mimetype } => {
                // Only text crosses the clipboard boundary; anything
                // else would need the audited file path instead.
                if mimetype.starts_with("text/") {
                    self.open_clipboard(stream);
                }
                return Ok(None);
            }
            ClientInstruction::Blob { stream, data } => {
                // `blob` is shared between clipboard and upload streams,
                // so the opcode alone does not say where it belongs.
                if self.upload_streams.contains(&stream) {
                    let Ok(decoded) = BASE64.decode(&data) else {
                        tracing::debug!(session = %self.id, stream, "discarding malformed upload blob");
                        return Ok(None);
                    };
                    InputEvent::File(FileRequest::Data {
                        stream,
                        data: Bytes::from(decoded),
                    })
                } else {
                    self.append_clipboard(stream, &data);
                    return Ok(None);
                }
            }
            ClientInstruction::End { stream } => {
                if self.upload_streams.remove(&stream) {
                    InputEvent::File(FileRequest::End { stream })
                } else {
                    let Some(pending) = self.clipboard_streams.remove(&stream) else {
                        return Ok(None);
                    };
                    InputEvent::Clipboard(Bytes::from(pending.data))
                }
            }
            ClientInstruction::Get { object, name } => {
                InputEvent::File(FileRequest::Get { object, name })
            }
            ClientInstruction::Put {
                object,
                stream,
                mimetype,
                name,
            } => {
                if self.stream_in_use(stream) || self.upload_streams.len() >= MAX_UPLOAD_STREAMS {
                    tracing::warn!(session = %self.id, stream, "upload refused: stream limit or reused id");
                    return Ok(None);
                }
                self.upload_streams.insert(stream);
                InputEvent::File(FileRequest::Put {
                    object,
                    stream,
                    mimetype,
                    name,
                })
            }
            ClientInstruction::Ack { stream, status, .. } => {
                InputEvent::File(FileRequest::Ack { stream, status })
            }
            // Sync/nop bookkeeping never reaches the target.
            ClientInstruction::Sync { .. }
            | ClientInstruction::Nop
            | ClientInstruction::Unhandled { .. } => return Ok(None),
        };

        if let Some(moderator) = &self.moderator {
            if let Moderation::Deny { reason } = moderator.review(&input) {
                tracing::info!(session = %self.id, %reason, "input blocked by dual control");
                return Ok(None);
            }
        }

        // Recorded after moderation, so the recording shows what reached
        // the target rather than what was attempted and refused.
        if self.recording.include_keys {
            if let InputEvent::Key { keysym, pressed } = input {
                self.record_key(keysym, pressed).await?;
            }
        }

        self.engine.handle_input(input).await?;
        Ok(None)
    }

    /// Write one keystroke into the recording.
    ///
    /// Emitted as the client's own `key` instruction so existing players
    /// and `guacenc` read it without being taught a new opcode.
    async fn record_key(&mut self, keysym: u32, pressed: bool) -> Result<(), SessionError> {
        let mut out = BytesMut::new();
        encode_instruction(
            &mut out,
            "key",
            &[&keysym.to_string(), if pressed { "1" } else { "0" }],
        );
        let record = AuditRecord {
            seq: self.seq,
            timestamp_ms: now_ms(),
            frame: ClientFrame::Text(out.freeze()),
        };
        self.seq += 1;
        self.audit.record(record).await
    }

    /// Whether a client stream index is already carrying something.
    fn stream_in_use(&self, stream: i32) -> bool {
        self.clipboard_streams.contains_key(&stream) || self.upload_streams.contains(&stream)
    }

    /// Start receiving a clipboard stream, within the session's limits.
    fn open_clipboard(&mut self, stream: i32) {
        self.clipboard_streams
            .retain(|_, pending| pending.touched.elapsed() < CLIPBOARD_IDLE);
        if self.stream_in_use(stream) {
            tracing::warn!(session = %self.id, stream, "clipboard refused: stream id already in use");
            return;
        }
        if self.clipboard_streams.len() >= MAX_CLIPBOARD_STREAMS {
            tracing::warn!(session = %self.id, stream, "clipboard refused: too many open streams");
            return;
        }
        self.clipboard_streams.insert(
            stream,
            PendingClipboard {
                data: Vec::new(),
                touched: Instant::now(),
            },
        );
    }

    /// Accumulate one `blob` of an in-flight clipboard stream.
    fn append_clipboard(&mut self, stream: i32, data: &str) {
        let buffered: usize = self.clipboard_streams.values().map(|p| p.data.len()).sum();
        let Some(pending) = self.clipboard_streams.get_mut(&stream) else {
            return;
        };
        // Checked against the decoded size before decoding, so an
        // oversize blob is never allocated.
        let incoming = base64::decoded_len_estimate(data.len());
        if pending.data.len() + incoming > MAX_CLIPBOARD_BYTES
            || buffered + incoming > MAX_CLIPBOARD_SESSION_BYTES
        {
            tracing::warn!(session = %self.id, stream, "clipboard stream too large; discarded");
            self.clipboard_streams.remove(&stream);
            return;
        }
        let Ok(decoded) = BASE64.decode(data) else {
            tracing::debug!(session = %self.id, stream, "discarding malformed clipboard blob");
            self.clipboard_streams.remove(&stream);
            return;
        };
        pending.data.extend_from_slice(&decoded);
        pending.touched = Instant::now();
    }

    async fn on_target_event(&mut self, event: TargetEvent) -> Result<(), SessionError> {
        // A refused upload is over: free its id so refusals cannot fill
        // the upload limit.
        if let TargetEvent::File(FileEvent::Ack { stream, status, .. }) = &event {
            if *status != 0 {
                self.upload_streams.remove(stream);
            }
        }
        // Only non-keyframe video may be sacrificed under backpressure;
        // dropping anything else desynchronises the client's canvas.
        let droppable = matches!(
            event,
            TargetEvent::VideoSlice {
                keyframe: false,
                ..
            }
        );

        let mut frames = Vec::new();
        self.encoder.encode(&event, &mut frames);
        let output = is_graphical_output(&event);
        for frame in frames {
            self.emit(frame, droppable, output).await?;
        }
        self.emit_sync().await?;
        Ok(())
    }

    async fn emit_sync(&mut self) -> Result<(), SessionError> {
        let mut frames = Vec::new();
        self.encoder
            .sync(i64::try_from(now_ms()).unwrap_or(i64::MAX), &mut frames);
        for frame in frames {
            // Timing, not content: a recording without it cannot be
            // replayed at the speed it happened.
            self.emit(frame, false, false).await?;
        }
        Ok(())
    }

    async fn emit(
        &mut self,
        frame: ClientFrame,
        droppable: bool,
        output: bool,
    ) -> Result<(), SessionError> {
        let record = SessionFrame {
            seq: self.seq,
            timestamp_ms: now_ms(),
            frame,
        };
        self.seq += 1;

        if !(output && self.recording.exclude_output) {
            self.audit
                .record(AuditRecord {
                    seq: record.seq,
                    timestamp_ms: record.timestamp_ms,
                    frame: record.frame.clone(),
                })
                .await?;
        }

        // No observers is the normal case, and a lagging observer is
        // that observer's problem — neither may stall the operator.
        let _ = self.observers.send(record.clone());

        if droppable {
            if self.to_client.try_send(record.frame).is_err() {
                self.dropped_frames += 1;
                tracing::debug!(
                    session = %self.id,
                    dropped = self.dropped_frames,
                    "dropped a non-keyframe slice under backpressure"
                );
            }
            return Ok(());
        }

        self.to_client
            .send(record.frame)
            .await
            .map_err(|_| SessionError::PipelineClosed("client writer"))
    }

    async fn teardown(mut self, reason: &str) -> Result<(), SessionError> {
        tracing::info!(session = %self.id, %reason, frames = self.seq, "tearing down session");

        // Every step runs even if an earlier one failed: a socket that
        // refuses to close must not leave a credential live or an audit
        // log unflushed.
        let engine = bounded(self.engine.shutdown(), || {
            Err(EngineError::Transport(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "engine shutdown timed out",
            )))
        })
        .await;
        let audit = bounded(self.audit.finalize(), || {
            Err(SessionError::Audit(
                "recording finalise timed out".to_owned(),
            ))
        })
        .await;
        let credential = match self.credential.as_mut() {
            Some(guard) => {
                bounded(guard.revoke(), || {
                    Err(SessionError::PipelineClosed("credential revoke timed out"))
                })
                .await
            }
            None => Ok(()),
        };

        if let Err(err) = engine {
            tracing::warn!(session = %self.id, error = %err, "engine shutdown failed");
        }
        credential?;
        audit
    }
}

/// Run one teardown step within [`TEARDOWN_STEP`].
async fn bounded<T>(fut: impl std::future::Future<Output = T>, timed_out: impl FnOnce() -> T) -> T {
    tokio::time::timeout(TEARDOWN_STEP, fut)
        .await
        .unwrap_or_else(|_| timed_out())
}

/// What the user is told when the engine fails rather than ending cleanly.
fn describe_engine_failure(err: &EngineError) -> (String, DisconnectCause) {
    let (reason, cause) = match err {
        EngineError::Transport(io) if io.kind() == std::io::ErrorKind::TimedOut => (
            "The remote computer stopped responding, so the connection was dropped.",
            DisconnectCause::ConnectionLost,
        ),
        EngineError::Transport(_) => (
            "The network connection to the remote computer was lost.",
            DisconnectCause::ConnectionLost,
        ),
        EngineError::Closed(_) => (
            "The remote computer closed the connection unexpectedly.",
            DisconnectCause::ConnectionLost,
        ),
        EngineError::AuthRejected => (
            "The remote computer rejected the credentials.",
            DisconnectCause::Unauthorized,
        ),
        EngineError::Protocol(_) | EngineError::Unsupported(_) => (
            "The session ended because of an unexpected response from the remote computer.",
            DisconnectCause::Failed,
        ),
    };
    (reason.to_owned(), cause)
}

/// Milliseconds since the Unix epoch, saturating at zero before 1970.
#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actor::audit::NullAuditSink;
    use crate::engine::mock::MockEngine;
    use crate::engine::Protocol;
    use crate::transport::{GuacWireEncoder, StreamingMode};
    use bytes::Bytes;
    use std::sync::{Arc, Mutex};

    fn spawn_session() -> (
        SessionHandle,
        mpsc::Receiver<ClientFrame>,
        mpsc::UnboundedSender<TargetEvent>,
        crate::engine::mock::InputLog,
    ) {
        let (engine, events, inputs) = MockEngine::new(Protocol::Rdp);
        let (handle, frames) = SessionActor::spawn(SessionConfig {
            id: "test-session".to_owned(),
            engine: Box::new(engine),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(NullAuditSink),
            recording: RecordingPolicy::default(),
            moderator: None,
            credential: None,
        });
        (handle, frames, events, inputs)
    }

    /// Collects everything written to the recording so a test can assert
    /// on what an auditor would actually read back.
    #[derive(Clone, Default)]
    struct SpyAuditSink(Arc<Mutex<Vec<u8>>>);

    #[async_trait::async_trait]
    impl crate::actor::audit::AuditSink for SpyAuditSink {
        async fn record(&mut self, record: AuditRecord) -> Result<(), SessionError> {
            if let ClientFrame::Text(bytes) = &record.frame {
                self.0.lock().unwrap().extend_from_slice(bytes);
            }
            Ok(())
        }
        async fn finalize(&mut self) -> Result<(), SessionError> {
            Ok(())
        }
    }

    impl SpyAuditSink {
        fn recorded(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    fn spawn_recorded(
        recording: RecordingPolicy,
    ) -> (
        SessionHandle,
        mpsc::Receiver<ClientFrame>,
        mpsc::UnboundedSender<TargetEvent>,
        SpyAuditSink,
    ) {
        let (engine, events, _inputs) = MockEngine::new(Protocol::Rdp);
        let spy = SpyAuditSink::default();
        let (handle, frames) = SessionActor::spawn(SessionConfig {
            id: "recorded-session".to_owned(),
            engine: Box::new(engine),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(spy.clone()),
            recording,
            moderator: None,
            credential: None,
        });
        (handle, frames, events, spy)
    }

    async fn settle() {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }

    #[tokio::test]
    async fn a_recording_holds_the_screen_by_default() {
        let (_handle, _frames, events, spy) = spawn_recorded(RecordingPolicy::default());
        events
            .send(TargetEvent::Resized {
                width: 800,
                height: 600,
            })
            .expect("send");
        settle().await;
        assert!(spy.recorded().contains("size"), "{:?}", spy.recorded());
    }

    /// The whole point of the option: a screen the recording was not
    /// authorised to keep must not reach the file.
    #[tokio::test]
    async fn excluding_output_keeps_the_screen_out_of_the_recording() {
        let (_handle, _frames, events, spy) = spawn_recorded(RecordingPolicy {
            exclude_output: true,
            ..RecordingPolicy::default()
        });
        events
            .send(TargetEvent::Resized {
                width: 800,
                height: 600,
            })
            .expect("send");
        events
            .send(TargetEvent::ImageUpdate {
                x: 0,
                y: 0,
                mimetype: "image/png",
                data: Bytes::from_static(b"not-really-a-png"),
            })
            .expect("send");
        settle().await;

        let recorded = spy.recorded();
        for graphical in ["size", "img", "blob"] {
            assert!(
                !recorded.contains(graphical),
                "`{graphical}` survived exclusion: {recorded:?}"
            );
        }
        // Timing must survive, or the recording cannot be replayed at the
        // speed it happened.
        assert!(recorded.contains("sync"), "{recorded:?}");
    }

    #[tokio::test]
    async fn keystrokes_stay_out_of_the_recording_unless_asked_for() {
        let (handle, _frames, _events, spy) = spawn_recorded(RecordingPolicy::default());
        handle
            .send(ClientInstruction::Key {
                keysym: 0x41,
                pressed: true,
            })
            .await
            .expect("send");
        settle().await;
        assert!(!spy.recorded().contains("key"), "{:?}", spy.recorded());
    }

    #[tokio::test]
    async fn including_keys_records_them_as_the_client_sent_them() {
        let (handle, _frames, _events, spy) = spawn_recorded(RecordingPolicy {
            include_keys: true,
            ..RecordingPolicy::default()
        });
        handle
            .send(ClientInstruction::Key {
                keysym: 0x41,
                pressed: true,
            })
            .await
            .expect("send");
        settle().await;
        // `3.key,2.65,1.1;` — the client's own opcode, so existing
        // players need no new instruction.
        assert!(
            spy.recorded().contains("3.key,2.65,1.1;"),
            "{:?}",
            spy.recorded()
        );
    }

    #[tokio::test]
    async fn client_input_reaches_the_engine() {
        let (handle, _frames, _events, inputs) = spawn_session();
        handle
            .send(ClientInstruction::Mouse {
                x: 10,
                y: 20,
                mask: 1,
            })
            .await
            .unwrap();
        handle
            .send(ClientInstruction::Key {
                keysym: 65,
                pressed: true,
            })
            .await
            .unwrap();
        // Nop must never be forwarded to the target.
        handle.send(ClientInstruction::Nop).await.unwrap();

        tokio::task::yield_now().await;
        let recorded = loop {
            let snapshot = inputs.lock().unwrap().clone();
            if snapshot.len() == 2 {
                break snapshot;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(
            recorded,
            vec![
                InputEvent::Mouse {
                    x: 10,
                    y: 20,
                    mask: 1
                },
                InputEvent::Key {
                    keysym: 65,
                    pressed: true
                },
            ]
        );
    }

    #[tokio::test]
    async fn target_events_are_encoded_for_the_client() {
        let (_handle, mut frames, events, _inputs) = spawn_session();
        events
            .send(TargetEvent::Resized {
                width: 1280,
                height: 720,
            })
            .unwrap();
        let frame = frames.recv().await.unwrap();
        assert_eq!(
            frame,
            ClientFrame::Text(Bytes::from_static(b"4.size,1.0,4.1280,3.720;"))
        );

        let sync = frames.recv().await.unwrap();
        let ClientFrame::Text(bytes) = sync else {
            panic!("expected a text sync instruction");
        };
        assert!(bytes.starts_with(b"4.sync,"));
    }

    #[tokio::test]
    async fn observers_see_the_same_frames_without_stealing_them() {
        let (handle, mut frames, events, _inputs) = spawn_session();
        let mut observer = handle.observe().await.unwrap();

        events
            .send(TargetEvent::Resized {
                width: 800,
                height: 600,
            })
            .unwrap();

        let operator = frames.recv().await.unwrap();
        let observed = observer.recv().await.unwrap();
        assert_eq!(observed.frame, operator);
        assert_eq!(observed.seq, 0);
    }

    #[tokio::test]
    async fn dual_control_blocks_input_without_ending_the_session() {
        struct DenyAll;
        impl InputModerator for DenyAll {
            fn review(&self, _input: &InputEvent) -> Moderation {
                Moderation::Deny {
                    reason: "awaiting approval".to_owned(),
                }
            }
        }

        let (engine, events, inputs) = MockEngine::new(Protocol::Ssh);
        let (handle, mut frames) = SessionActor::spawn(SessionConfig {
            id: "moderated".to_owned(),
            engine: Box::new(engine),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(NullAuditSink),
            recording: RecordingPolicy::default(),
            moderator: Some(Box::new(DenyAll)),
            credential: None,
        });

        handle
            .send(ClientInstruction::Key {
                keysym: 65,
                pressed: true,
            })
            .await
            .unwrap();
        events
            .send(TargetEvent::Resized {
                width: 640,
                height: 480,
            })
            .unwrap();

        // The session is still alive and still rendering...
        assert!(frames.recv().await.is_some());
        // ...but the keystroke never reached the target.
        assert!(inputs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn teardown_revokes_the_credential() {
        struct Guard(Arc<Mutex<bool>>);
        #[async_trait]
        impl CredentialGuard for Guard {
            async fn revoke(&mut self) -> Result<(), SessionError> {
                *self.0.lock().unwrap() = true;
                Ok(())
            }
        }

        let revoked = Arc::new(Mutex::new(false));
        let (engine, events, _inputs) = MockEngine::new(Protocol::Rdp);
        let (handle, mut frames) = SessionActor::spawn(SessionConfig {
            id: "revoking".to_owned(),
            engine: Box::new(engine),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(NullAuditSink),
            recording: RecordingPolicy::default(),
            moderator: None,
            credential: Some(Box::new(Guard(Arc::clone(&revoked)))),
        });

        handle.terminate("test over").await.unwrap();
        drop(events);

        // The actor drops its frame sender only after teardown has run,
        // so a closed channel is a precise signal rather than a race.
        while frames.recv().await.is_some() {}
        assert!(*revoked.lock().unwrap(), "credential was never revoked");
    }

    /// Fails every write once `fail` is set; counts finalisation.
    #[derive(Clone, Default)]
    struct FlakySink {
        fail: Arc<Mutex<bool>>,
        finalized: Arc<Mutex<u32>>,
    }

    #[async_trait]
    impl crate::actor::audit::AuditSink for FlakySink {
        async fn record(&mut self, _record: AuditRecord) -> Result<(), SessionError> {
            if *self.fail.lock().unwrap() {
                return Err(SessionError::Audit("disk full".to_owned()));
            }
            Ok(())
        }
        async fn finalize(&mut self) -> Result<(), SessionError> {
            *self.finalized.lock().unwrap() += 1;
            Ok(())
        }
    }

    fn spawn_flaky() -> (
        SessionHandle,
        mpsc::Receiver<ClientFrame>,
        mpsc::UnboundedSender<TargetEvent>,
        FlakySink,
    ) {
        let (engine, events, _inputs) = MockEngine::new(Protocol::Rdp);
        let sink = FlakySink::default();
        let (handle, frames) = SessionActor::spawn(SessionConfig {
            id: "flaky".to_owned(),
            engine: Box::new(engine),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(sink.clone()),
            recording: RecordingPolicy::default(),
            moderator: None,
            credential: None,
        });
        (handle, frames, events, sink)
    }

    #[tokio::test]
    async fn a_recording_failure_ends_the_session_and_still_tears_down() {
        let (handle, mut frames, events, sink) = spawn_flaky();
        *sink.fail.lock().unwrap() = true;
        events
            .send(TargetEvent::Resized {
                width: 800,
                height: 600,
            })
            .expect("send");

        recv_until(&mut frames, "recording failed").await;
        tokio::time::timeout(Duration::from_secs(5), handle.closed())
            .await
            .expect("the session kept running after its recording failed");
        assert_eq!(*sink.finalized.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn a_vanished_client_still_gets_the_recording_finalised() {
        let (handle, frames, events, sink) = spawn_flaky();
        drop(frames);
        events
            .send(TargetEvent::Resized {
                width: 800,
                height: 600,
            })
            .expect("send");

        tokio::time::timeout(Duration::from_secs(5), handle.closed())
            .await
            .expect("the session outlived its client");
        assert_eq!(*sink.finalized.lock().unwrap(), 1);
    }

    /// Drain frames until one carries `needle`, so a test never races the
    /// periodic sync.
    async fn recv_until(frames: &mut mpsc::Receiver<ClientFrame>, needle: &str) {
        while let Some(frame) = frames.recv().await {
            if let ClientFrame::Text(bytes) = frame {
                if String::from_utf8_lossy(&bytes).contains(needle) {
                    return;
                }
            }
        }
        panic!("session ended before emitting {needle}");
    }

    /// Spin until the engine has logged `count` inputs, or give up.
    async fn wait_for_inputs(
        inputs: &crate::engine::mock::InputLog,
        count: usize,
    ) -> Vec<InputEvent> {
        for _ in 0..10_000 {
            let snapshot = inputs.lock().unwrap().clone();
            if snapshot.len() >= count {
                return snapshot;
            }
            tokio::task::yield_now().await;
        }
        inputs.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn a_client_cannot_hold_open_unlimited_clipboard_streams() {
        let (handle, _frames, _events, inputs) = spawn_session();
        let streams: Vec<i32> = (1..=i32::try_from(MAX_CLIPBOARD_STREAMS).unwrap() + 1).collect();
        for &stream in &streams {
            handle
                .send(ClientInstruction::Clipboard {
                    stream,
                    mimetype: "text/plain".to_owned(),
                })
                .await
                .unwrap();
        }
        for &stream in &streams {
            handle
                .send(ClientInstruction::Blob {
                    stream,
                    data: BASE64.encode(b"x"),
                })
                .await
                .unwrap();
            handle
                .send(ClientInstruction::End { stream })
                .await
                .unwrap();
        }

        let recorded = wait_for_inputs(&inputs, streams.len()).await;
        assert_eq!(
            recorded.len(),
            MAX_CLIPBOARD_STREAMS,
            "the stream over the limit was accepted"
        );
    }

    #[tokio::test]
    async fn reopening_an_open_stream_id_does_not_reset_it() {
        let (handle, _frames, _events, inputs) = spawn_session();
        let open = || ClientInstruction::Clipboard {
            stream: 2,
            mimetype: "text/plain".to_owned(),
        };
        handle.send(open()).await.unwrap();
        handle
            .send(ClientInstruction::Blob {
                stream: 2,
                data: BASE64.encode(b"first "),
            })
            .await
            .unwrap();
        handle.send(open()).await.unwrap();
        handle
            .send(ClientInstruction::Blob {
                stream: 2,
                data: BASE64.encode(b"second"),
            })
            .await
            .unwrap();
        handle
            .send(ClientInstruction::End { stream: 2 })
            .await
            .unwrap();

        assert_eq!(
            wait_for_inputs(&inputs, 1).await,
            vec![InputEvent::Clipboard(Bytes::from_static(b"first second"))]
        );
    }

    #[tokio::test]
    async fn a_clipboard_stream_reaches_the_target_reassembled() {
        let (handle, _frames, _events, inputs) = spawn_session();
        handle
            .send(ClientInstruction::Clipboard {
                stream: 3,
                mimetype: "text/plain".to_owned(),
            })
            .await
            .unwrap();
        for chunk in [b"hello ".as_slice(), b"world".as_slice()] {
            handle
                .send(ClientInstruction::Blob {
                    stream: 3,
                    data: BASE64.encode(chunk),
                })
                .await
                .unwrap();
        }
        handle
            .send(ClientInstruction::End { stream: 3 })
            .await
            .unwrap();

        let recorded = wait_for_inputs(&inputs, 1).await;
        assert_eq!(
            recorded,
            vec![InputEvent::Clipboard(Bytes::from_static(b"hello world"))]
        );
    }

    #[tokio::test]
    async fn a_clipboard_stream_that_never_ends_cannot_grow_without_bound() {
        // A peer that opens a stream and keeps sending is the memory
        // exhaustion case the cap exists for; the stream is dropped
        // rather than the session, so a bad paste is not a disconnect.
        let (handle, _frames, _events, inputs) = spawn_session();
        handle
            .send(ClientInstruction::Clipboard {
                stream: 1,
                mimetype: "text/plain".to_owned(),
            })
            .await
            .unwrap();

        let megabyte = BASE64.encode(vec![b'x'; 1024 * 1024]);
        for _ in 0..(MAX_CLIPBOARD_BYTES / (1024 * 1024)) + 2 {
            handle
                .send(ClientInstruction::Blob {
                    stream: 1,
                    data: megabyte.clone(),
                })
                .await
                .unwrap();
        }
        handle
            .send(ClientInstruction::End { stream: 1 })
            .await
            .unwrap();

        // The discarded stream has no buffer left to flush on `end`.
        assert!(
            wait_for_inputs(&inputs, 1).await.is_empty(),
            "an oversize clipboard stream still reached the target"
        );
    }

    #[tokio::test]
    async fn a_malformed_clipboard_blob_discards_the_stream() {
        let (handle, _frames, _events, inputs) = spawn_session();
        handle
            .send(ClientInstruction::Clipboard {
                stream: 7,
                mimetype: "text/plain".to_owned(),
            })
            .await
            .unwrap();
        handle
            .send(ClientInstruction::Blob {
                stream: 7,
                data: "not valid base64!!".to_owned(),
            })
            .await
            .unwrap();
        handle
            .send(ClientInstruction::End { stream: 7 })
            .await
            .unwrap();

        assert!(
            wait_for_inputs(&inputs, 1).await.is_empty(),
            "a malformed clipboard blob was forwarded to the target"
        );
    }

    #[tokio::test]
    async fn a_native_session_writes_a_replayable_recording() {
        // The recording sink was wired to the native path but never
        // exercised end to end, so nothing proved a session routed here
        // still leaves the audit trail the guacd path produced.
        let dir = std::env::temp_dir().join(format!("strata-rec-{}", uuid::Uuid::new_v4()));
        let path = dir.join("session.guac");
        let sink = crate::actor::audit::GuacRecordingSink::create(&path)
            .await
            .unwrap();

        let (engine, events, _inputs) = MockEngine::new(Protocol::Rdp);
        let (handle, mut frames) = SessionActor::spawn(SessionConfig {
            id: "recorded".to_owned(),
            engine: Box::new(engine),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(sink),
            recording: RecordingPolicy::default(),
            moderator: None,
            credential: None,
        });

        events
            .send(TargetEvent::Resized {
                width: 1024,
                height: 768,
            })
            .unwrap();
        events
            .send(TargetEvent::Clipboard(Bytes::from_static(b"copied")))
            .unwrap();
        // Terminate arrives on the control channel, which the actor may
        // select ahead of these. Waiting for a frame count would race the
        // periodic sync, so wait for the instruction itself.
        recv_until(&mut frames, "clipboard").await;

        handle.terminate("test over").await.unwrap();
        drop(events);
        while frames.recv().await.is_some() {}

        let written = String::from_utf8(tokio::fs::read(&path).await.unwrap()).unwrap();
        // A raw instruction stream, exactly as guacd would have written:
        // any framing or timestamps here would break existing players.
        assert!(
            written.contains("4.size,"),
            "no size instruction: {written}"
        );
        assert!(
            written.contains("4.1024"),
            "desktop size missing: {written}"
        );
        assert!(
            written.contains("9.clipboard,"),
            "clipboard was not recorded: {written}"
        );
        assert!(
            written.ends_with(';'),
            "recording ends mid-instruction: {written}"
        );

        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn a_target_disconnect_ends_the_session() {
        let (handle, mut frames, events, _inputs) = spawn_session();
        events
            .send(TargetEvent::Disconnected {
                reason: "host rebooted".to_owned(),
                cause: DisconnectCause::Ended,
            })
            .unwrap();

        let frame = frames.recv().await.unwrap();
        let ClientFrame::Text(bytes) = frame else {
            panic!("expected a text error instruction");
        };
        assert!(bytes.starts_with(b"5.error,"));

        // The actor has exited, so the handle no longer accepts input.
        while handle.send(ClientInstruction::Nop).await.is_ok() {
            tokio::task::yield_now().await;
        }
    }

    struct BrokenEngine;

    #[async_trait]
    impl ProtocolEngine for BrokenEngine {
        fn protocol(&self) -> Protocol {
            Protocol::Rdp
        }
        async fn handle_input(&mut self, _input: InputEvent) -> Result<(), EngineError> {
            Ok(())
        }
        async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
            Err(EngineError::Transport(
                std::io::ErrorKind::ConnectionReset.into(),
            ))
        }
        async fn shutdown(&mut self) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_failed_engine_tells_the_client_the_connection_was_lost() {
        // Without this the socket just closed, and the browser could only
        // guess — it guessed "you logged out".
        let (_handle, mut frames) = SessionActor::spawn(SessionConfig {
            id: "broken".to_owned(),
            engine: Box::new(BrokenEngine),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(NullAuditSink),
            recording: RecordingPolicy::default(),
            moderator: None,
            credential: None,
        });

        let ClientFrame::Text(bytes) = frames.recv().await.unwrap() else {
            panic!("expected a text error instruction");
        };
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("5.error,"), "{text}");
        assert!(
            text.contains("connection to the remote computer was lost"),
            "{text}"
        );
        assert!(text.ends_with(",3.515;"), "{text}");
    }

    #[test]
    fn encoder_mode_is_reported_for_metrics() {
        assert_eq!(GuacWireEncoder::new().mode(), StreamingMode::GuacWire);
    }
}
