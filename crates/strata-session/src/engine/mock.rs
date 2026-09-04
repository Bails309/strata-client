//! In-process engine used by tests and the protocol parity harness.
//!
//! Records every [`InputEvent`] it is handed and replays a scripted list
//! of [`TargetEvent`]s, so the actor pipeline can be exercised end to
//! end without a Windows host or an SSH daemon in the loop.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::engine::{EngineFactory, InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec};
use crate::error::EngineError;

/// Shared, inspectable log of the inputs an engine received.
pub type InputLog = Arc<Mutex<Vec<InputEvent>>>;

/// A scriptable engine.
pub struct MockEngine {
    protocol: Protocol,
    events: mpsc::UnboundedReceiver<TargetEvent>,
    inputs: InputLog,
    shutdown_calls: Arc<Mutex<usize>>,
}

impl MockEngine {
    /// Create an engine plus the sender used to feed it target events.
    #[must_use]
    pub fn new(protocol: Protocol) -> (Self, mpsc::UnboundedSender<TargetEvent>, InputLog) {
        let (tx, rx) = mpsc::unbounded_channel();
        let inputs: InputLog = Arc::new(Mutex::new(Vec::new()));
        let engine = Self {
            protocol,
            events: rx,
            inputs: Arc::clone(&inputs),
            shutdown_calls: Arc::new(Mutex::new(0)),
        };
        (engine, tx, inputs)
    }

    /// How many times [`ProtocolEngine::shutdown`] has been called.
    #[must_use]
    pub fn shutdown_counter(&self) -> Arc<Mutex<usize>> {
        Arc::clone(&self.shutdown_calls)
    }
}

#[async_trait]
impl ProtocolEngine for MockEngine {
    fn protocol(&self) -> Protocol {
        self.protocol
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        self.inputs
            .lock()
            .expect("mock input log poisoned")
            .push(input);
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        Ok(self.events.recv().await)
    }

    async fn shutdown(&mut self) -> Result<(), EngineError> {
        *self
            .shutdown_calls
            .lock()
            .expect("mock shutdown counter poisoned") += 1;
        self.events.close();
        Ok(())
    }
}

/// Factory that always yields a [`MockEngine`] with no scripted events.
pub struct MockEngineFactory;

#[async_trait]
impl EngineFactory for MockEngineFactory {
    async fn connect(&self, spec: TargetSpec) -> Result<Box<dyn ProtocolEngine>, EngineError> {
        let (engine, _tx, _inputs) = MockEngine::new(spec.protocol);
        Ok(Box::new(engine))
    }
}
