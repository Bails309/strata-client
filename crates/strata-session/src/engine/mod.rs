//! Protocol engine abstraction.
//!
//! Everything above this layer — the session actor, the frame
//! dispatcher, the audit sink — is protocol-agnostic. An engine owns one
//! connection to one target and translates between [`InputEvent`] and
//! [`TargetEvent`].
//!
//! Engines are *sans-I/O at the edges*: they own their own socket, but
//! they must never spawn hidden OS threads and [`ProtocolEngine::next_event`]
//! must be cancel-safe, because the session actor drives it inside a
//! `tokio::select!`.

use async_trait::async_trait;
use bytes::Bytes;
use secrecy::SecretString;

use crate::error::EngineError;

pub mod mock;

#[cfg(feature = "rdp")]
pub mod rdp;

#[cfg(feature = "ssh")]
pub mod ssh;

/// Which remote-access protocol an engine speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Protocol {
    /// Remote Desktop Protocol.
    Rdp,
    /// Secure Shell.
    Ssh,
    /// Virtual Network Computing (RFB).
    Vnc,
    /// Kubernetes pod exec streams.
    KubeExec,
}

impl Protocol {
    /// Lower-case wire name, as used in the `select` instruction.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rdp => "rdp",
            Self::Ssh => "ssh",
            Self::Vnc => "vnc",
            Self::KubeExec => "kubernetes",
        }
    }
}

/// Everything an engine needs to reach a target.
///
/// The secret is held in a [`SecretString`] so it is zeroed on drop and
/// never lands in a `Debug` rendering, a log line or a process argument
/// vector — the exposure guacd required when credentials were passed as
/// connection parameters.
pub struct TargetSpec {
    /// Protocol to speak.
    pub protocol: Protocol,
    /// Target hostname or address.
    pub hostname: String,
    /// Target port.
    pub port: u16,
    /// Account to authenticate as.
    pub username: String,
    /// Ephemeral credential checked out from Vault.
    pub secret: SecretString,
    /// Initial display width in pixels.
    pub width: u32,
    /// Initial display height in pixels.
    pub height: u32,
}

impl std::fmt::Debug for TargetSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TargetSpec")
            .field("protocol", &self.protocol)
            .field("hostname", &self.hostname)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("secret", &"<redacted>")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

/// User interaction travelling towards the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// Pointer state.
    Mouse {
        /// X coordinate in pixels.
        x: i32,
        /// Y coordinate in pixels.
        y: i32,
        /// Button bitmask.
        mask: u8,
    },
    /// Keyboard state.
    Key {
        /// X11 keysym.
        keysym: u32,
        /// `true` for press.
        pressed: bool,
    },
    /// The client display changed size.
    Resize {
        /// New width in pixels.
        width: u32,
        /// New height in pixels.
        height: u32,
    },
    /// Clipboard contents pushed from the client.
    Clipboard(Bytes),
    /// Raw bytes for a character-oriented target (SSH PTY input).
    Text(Bytes),
    /// The client asked to end the session.
    Disconnect,
}

/// Video codec carried by [`TargetEvent::VideoSlice`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    /// H.264, Annex-B framed.
    H264,
    /// AV1 OBU stream.
    Av1,
}

/// Something that happened on the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetEvent {
    /// A rectangle of the display changed, already encoded as an image.
    ///
    /// Engines hand over compressed bytes rather than raw pixels so the
    /// dispatcher never has to own a rasteriser.
    ImageUpdate {
        /// Destination X.
        x: i32,
        /// Destination Y.
        y: i32,
        /// Image mimetype, e.g. `image/webp`.
        mimetype: &'static str,
        /// Encoded image bytes.
        data: Bytes,
    },
    /// A compressed video slice lifted straight off the target.
    ///
    /// This is the payload that makes Native Direct Streaming Mode worth
    /// having: it is forwarded to the browser untouched.
    VideoSlice {
        /// Codec of `data`.
        codec: VideoCodec,
        /// Whether this slice can be decoded without prior frames.
        keyframe: bool,
        /// Capture time in milliseconds since the Unix epoch.
        timestamp_ms: u64,
        /// Compressed bitstream.
        data: Bytes,
    },
    /// Raw terminal output from a character-oriented target.
    TerminalOutput(Bytes),
    /// The target's clipboard changed.
    Clipboard(Bytes),
    /// The target's display resolution changed.
    Resized {
        /// New width in pixels.
        width: u32,
        /// New height in pixels.
        height: u32,
    },
    /// The mouse cursor changed shape.
    ///
    /// Carried as its own event so the client can own the pointer:
    /// compositing it into the framebuffer instead costs an image update
    /// per mouse move and leaves a trail wherever an update is missed.
    CursorImage {
        /// Hotspot X within the bitmap.
        hotspot_x: u32,
        /// Hotspot Y within the bitmap.
        hotspot_y: u32,
        /// Bitmap width.
        width: u32,
        /// Bitmap height.
        height: u32,
        /// Image mimetype, e.g. `image/png`.
        mimetype: &'static str,
        /// Encoded image bytes.
        data: Bytes,
    },
    /// The target hid the mouse cursor.
    CursorHidden,
    /// The session ended.
    Disconnected {
        /// Human-readable reason.
        reason: String,
    },
}

/// A live connection to one target.
#[async_trait]
pub trait ProtocolEngine: Send + 'static {
    /// Which protocol this engine speaks.
    fn protocol(&self) -> Protocol;

    /// Forward user interaction to the target.
    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError>;

    /// Await the next event from the target.
    ///
    /// Returns `Ok(None)` once the target is finished. **Must be
    /// cancel-safe**: the session actor polls this inside `select!` and
    /// will drop the future whenever client input arrives first. An
    /// implementation that buffers a partial read in a local variable
    /// will lose data here; keep partial state in `self`.
    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError>;

    /// Close the target connection and release its resources.
    async fn shutdown(&mut self) -> Result<(), EngineError>;
}

/// Constructs engines for a requested target.
///
/// Injected into [`SessionManager`](crate::actor::SessionManager) so the
/// dual-stack rollout can swap real engines for mocks in tests, and so
/// the backend can keep routing selected protocols at guacd during
/// Phase 2 without the session tier knowing.
#[async_trait]
pub trait EngineFactory: Send + Sync + 'static {
    /// Open a connection to `spec`.
    async fn connect(&self, spec: TargetSpec) -> Result<Box<dyn ProtocolEngine>, EngineError>;
}
