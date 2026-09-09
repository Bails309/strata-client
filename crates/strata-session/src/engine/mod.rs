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
use std::net::IpAddr;

use crate::error::EngineError;

pub mod mock;

pub mod keymap;

#[cfg(feature = "kubernetes")]
pub mod kube;

#[cfg(feature = "rdp")]
pub mod rdp;

#[cfg(feature = "sftp")]
pub mod sftp;

#[cfg(feature = "ssh")]
pub mod ssh;

#[cfg(feature = "vnc")]
pub mod vnc;

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
    /// Address to open the socket to, when the caller resolved the
    /// hostname itself.
    ///
    /// `hostname` is still what gets presented for TLS verification and
    /// the Kerberos SPN, so pre-resolving does not turn a name-based
    /// handshake into an address-based one. `None` leaves resolution to
    /// the system resolver.
    pub connect_addr: Option<IpAddr>,
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

impl TargetSpec {
    /// What to hand a socket constructor: the resolved address when the
    /// caller supplied one, otherwise the hostname.
    #[must_use]
    pub fn dial_host(&self) -> String {
        self.connect_addr
            .map_or_else(|| self.hostname.clone(), |ip| ip.to_string())
    }
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
    /// File transfer, which only the SFTP decorator acts on.
    ///
    /// Nested rather than flattened into this enum: every engine has to
    /// match it exhaustively, and five more variants would mean five
    /// more arms in each of them for something none of them handle.
    File(FileRequest),
    /// The client asked to end the session.
    Disconnect,
}

/// A file-transfer request from the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRequest {
    /// Read a file, or list a directory.
    Get {
        /// Filesystem object the path belongs to.
        object: i32,
        /// Absolute path within that object.
        name: String,
    },
    /// Begin writing a file.
    Put {
        /// Filesystem object the path belongs to.
        object: i32,
        /// Stream the client will send data on.
        stream: i32,
        /// Declared mimetype.
        mimetype: String,
        /// Absolute destination path.
        name: String,
    },
    /// A chunk of an upload.
    Data {
        /// Stream the chunk belongs to.
        stream: i32,
        /// Decoded bytes.
        data: Bytes,
    },
    /// An upload is complete.
    End {
        /// Stream that finished.
        stream: i32,
    },
    /// The client consumed a chunk the session sent, and will take more.
    Ack {
        /// Stream being acknowledged.
        stream: i32,
        /// Guacamole status code, 0 for success.
        status: i32,
    },
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
    /// Desktop audio from the target, as the PCM described by
    /// [`crate::engine::rdp::audio::MIMETYPE`].
    Audio(Bytes),
    /// A region of the display moved, rather than being repainted.
    ///
    /// RFB's CopyRect says so explicitly, which is why this exists: the
    /// equivalent for RDP had to be inferred from consecutive frames and
    /// never once matched.
    CopyRegion {
        /// Left edge of the source, in pixels.
        src_x: i32,
        /// Top edge of the source, in pixels.
        src_y: i32,
        /// Width of the moved region.
        width: u32,
        /// Height of the moved region.
        height: u32,
        /// Left edge of the destination.
        dst_x: i32,
        /// Top edge of the destination.
        dst_y: i32,
    },
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
    /// File transfer, produced only by the SFTP decorator.
    File(FileEvent),
    /// The session ended.
    Disconnected {
        /// Human-readable reason.
        reason: String,
    },
}

/// A file-transfer event heading for the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileEvent {
    /// Announce a filesystem the client may browse.
    Filesystem {
        /// Object index the client will name in later requests.
        object: i32,
        /// Name shown in the file browser.
        name: String,
    },
    /// Open a stream carrying a file or a directory listing.
    Body {
        /// Object the stream belongs to.
        object: i32,
        /// Stream index the data will follow on.
        stream: i32,
        /// Mimetype; directories use the stream-index type.
        mimetype: String,
        /// Path this stream corresponds to.
        name: String,
    },
    /// A chunk of a download.
    Data {
        /// Stream the chunk belongs to.
        stream: i32,
        /// Raw bytes, base64-encoded by the wire encoder.
        data: Bytes,
    },
    /// A download is complete.
    End {
        /// Stream that finished.
        stream: i32,
    },
    /// Acknowledge a client upload stream, or report why it failed.
    Ack {
        /// Stream being acknowledged.
        stream: i32,
        /// Human-readable message; empty on success.
        message: String,
        /// Guacamole status code, 0 for success.
        status: i32,
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
