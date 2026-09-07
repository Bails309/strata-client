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

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bytes::Bytes;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::actor::audit::{AuditRecord, AuditSink};
use crate::engine::{InputEvent, ProtocolEngine, TargetEvent};
use crate::error::SessionError;
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

/// Largest clipboard payload accepted from the client.
pub const MAX_CLIPBOARD_BYTES: usize = 8 * 1024 * 1024;

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
    moderator: Option<Box<dyn InputModerator>>,
    credential: Option<Box<dyn CredentialGuard>>,
    commands: mpsc::Receiver<SessionCommand>,
    to_client: mpsc::Sender<ClientFrame>,
    observers: broadcast::Sender<SessionFrame>,
    seq: u64,
    dropped_frames: u64,
    /// Partially received client clipboard streams, keyed by stream index.
    clipboard_streams: HashMap<i32, Vec<u8>>,
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
            moderator: config.moderator,
            credential: config.credential,
            commands: command_rx,
            to_client: frame_tx,
            observers,
            seq: 0,
            dropped_frames: 0,
            clipboard_streams: HashMap::new(),
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
                            if let Some(reason) = self.on_client_input(instruction).await? {
                                break reason;
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
                    self.emit_sync().await?;
                }
                event = self.engine.next_event() => {
                    match event {
                        Ok(Some(event)) => {
                            let disconnect = matches!(event, TargetEvent::Disconnected { .. });
                            self.on_target_event(event).await?;
                            if disconnect {
                                break "target disconnected".to_owned();
                            }
                        }
                        Ok(None) => break "target closed the stream".to_owned(),
                        Err(err) => {
                            tracing::warn!(session = %self.id, error = %err, "engine failure");
                            break format!("engine failure: {err}");
                        }
                    }
                }
            }
        };

        self.teardown(&reason).await
    }

    /// Returns `Some(reason)` when the session should end.
    async fn on_client_input(
        &mut self,
        instruction: ClientInstruction,
    ) -> Result<Option<String>, SessionError> {
        let input = match instruction {
            ClientInstruction::Mouse { x, y, mask } => InputEvent::Mouse { x, y, mask },
            ClientInstruction::Key { keysym, pressed } => InputEvent::Key { keysym, pressed },
            ClientInstruction::Size { width, height } => InputEvent::Resize { width, height },
            ClientInstruction::Disconnect => return Ok(Some("client requested disconnect".into())),
            ClientInstruction::Clipboard { stream, mimetype } => {
                // Only text crosses the clipboard boundary; anything
                // else would need the audited file path instead.
                if mimetype.starts_with("text/") {
                    self.clipboard_streams.insert(stream, Vec::new());
                }
                return Ok(None);
            }
            ClientInstruction::Blob { stream, data } => {
                self.append_clipboard(stream, &data);
                return Ok(None);
            }
            ClientInstruction::End { stream } => {
                let Some(payload) = self.clipboard_streams.remove(&stream) else {
                    return Ok(None);
                };
                InputEvent::Clipboard(Bytes::from(payload))
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

        self.engine.handle_input(input).await?;
        Ok(None)
    }

    /// Accumulate one `blob` of an in-flight clipboard stream.
    fn append_clipboard(&mut self, stream: i32, data: &str) {
        let Some(buffer) = self.clipboard_streams.get_mut(&stream) else {
            return;
        };
        let Ok(decoded) = BASE64.decode(data) else {
            tracing::debug!(session = %self.id, stream, "discarding malformed clipboard blob");
            self.clipboard_streams.remove(&stream);
            return;
        };
        // A peer that never sends `end` must not grow this without bound.
        if buffer.len() + decoded.len() > MAX_CLIPBOARD_BYTES {
            tracing::warn!(session = %self.id, stream, "clipboard stream too large; discarded");
            self.clipboard_streams.remove(&stream);
            return;
        }
        buffer.extend_from_slice(&decoded);
    }

    async fn on_target_event(&mut self, event: TargetEvent) -> Result<(), SessionError> {
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
        for frame in frames {
            self.emit(frame, droppable).await?;
        }
        self.emit_sync().await?;
        Ok(())
    }

    async fn emit_sync(&mut self) -> Result<(), SessionError> {
        let mut frames = Vec::new();
        self.encoder
            .sync(i64::try_from(now_ms()).unwrap_or(i64::MAX), &mut frames);
        for frame in frames {
            self.emit(frame, false).await?;
        }
        Ok(())
    }

    async fn emit(&mut self, frame: ClientFrame, droppable: bool) -> Result<(), SessionError> {
        let record = SessionFrame {
            seq: self.seq,
            timestamp_ms: now_ms(),
            frame,
        };
        self.seq += 1;

        self.audit
            .record(AuditRecord {
                seq: record.seq,
                timestamp_ms: record.timestamp_ms,
                frame: record.frame.clone(),
            })
            .await?;

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
        let engine = self.engine.shutdown().await;
        let audit = self.audit.finalize().await;
        let credential = match self.credential.as_mut() {
            Some(guard) => guard.revoke().await,
            None => Ok(()),
        };

        if let Err(err) = engine {
            tracing::warn!(session = %self.id, error = %err, "engine shutdown failed");
        }
        credential?;
        audit
    }
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
            moderator: None,
            credential: None,
        });
        (handle, frames, events, inputs)
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

    #[test]
    fn encoder_mode_is_reported_for_metrics() {
        assert_eq!(GuacWireEncoder::new().mode(), StreamingMode::GuacWire);
    }
}
