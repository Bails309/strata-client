//! RDP protocol engine built on [`ironrdp`].
//!
//! Replaces `libguac-client-rdp`, which drove FreeRDP — the largest
//! block of unmanaged C in the old session tier and the reason
//! `guacd/patches/` exists.
//!
//! `ironrdp` is sans-I/O: it owns no socket and spawns no threads. This
//! module supplies the transport and drives the state machine, which is
//! what lets an RDP session live as an ordinary Tokio task alongside
//! everything else.
//!
//! ## Graphics
//!
//! The active stage maintains a full-desktop framebuffer and reports the
//! rectangles that changed. Wire Compatibility Mode crops those
//! rectangles and PNG-encodes them, which is what `guacd` did — the
//! difference is that Direct Streaming Mode will later lift the
//! compressed EGFX bitstream out before this decode ever happens, which
//! is the whole point of the migration.

//! ## Threading
//!
//! `ironrdp-async` 0.7's connection future is not `Send` — its
//! `AsyncNetworkClient` hook is a bare trait object — so the session
//! cannot be driven directly from the shared Tokio runtime behind
//! [`ProtocolEngine`]. The whole RDP session therefore runs on its own
//! thread with a current-thread runtime, and this module exposes a
//! `Send` handle over channels. The runtime lives for the session's
//! lifetime, so its sockets stay registered with the reactor that owns
//! them.

pub mod keycodes;

use std::collections::VecDeque;

use async_trait::async_trait;
use bytes::Bytes;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use ironrdp_connector::{ClientConnector, Config as ConnectorConfig, Credentials, DesktopSize};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::geometry::Rectangle as _;
use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::PointerFlags;
use ironrdp_pdu::input::MousePdu;
use ironrdp_pdu::rdp::client_info::PerformanceFlags;
use ironrdp_pdu::Action;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageOutput};
use ironrdp_tokio::{FramedWrite as _, TokioFramed};
use secrecy::ExposeSecret;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_rustls::client::TlsStream;

use crate::engine::rdp::keycodes::keysym_to_scancode;
use crate::engine::{EngineFactory, InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec};
use crate::error::EngineError;

/// Events buffered from the session thread before it applies backpressure.
const EVENT_QUEUE_DEPTH: usize = 256;

/// Input events buffered towards the session thread.
const INPUT_QUEUE_DEPTH: usize = 256;

/// Engine-wide RDP settings.
#[derive(Debug, Clone)]
pub struct RdpConfig {
    /// Name this client announces to the target.
    pub client_name: String,
    /// Keyboard layout ID the target should assume (0x0409 = en-US).
    pub keyboard_layout: u32,
    /// Windows domain, when the account is not local to the target.
    pub domain: Option<String>,
}

impl Default for RdpConfig {
    fn default() -> Self {
        Self {
            client_name: "strata".to_owned(),
            keyboard_layout: 0x0409,
            domain: None,
        }
    }
}

/// Handle to an RDP session running on its own thread.
pub struct RdpEngine {
    events: mpsc::Receiver<Result<TargetEvent, EngineError>>,
    input: mpsc::Sender<InputEvent>,
    desktop: (u32, u32),
    finished: bool,
}

impl RdpEngine {
    /// Connect, authenticate over CredSSP, and reach the active stage.
    ///
    /// Returns once the session is live; the credential is consumed on
    /// the session thread and dropped there.
    pub async fn connect(spec: TargetSpec, config: &RdpConfig) -> Result<Self, EngineError> {
        let (event_tx, events) = mpsc::channel(EVENT_QUEUE_DEPTH);
        let (input, input_rx) = mpsc::channel(INPUT_QUEUE_DEPTH);
        let (ready_tx, ready_rx) = oneshot::channel();
        let config = config.clone();

        std::thread::Builder::new()
            .name("strata-rdp".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        let _ = ready_tx.send(Err(EngineError::Transport(err)));
                        return;
                    }
                };
                runtime.block_on(session_thread(spec, config, ready_tx, event_tx, input_rx));
            })
            .map_err(EngineError::Transport)?;

        let desktop = ready_rx
            .await
            .map_err(|_| EngineError::Closed("rdp session thread exited".to_owned()))??;

        Ok(Self {
            events,
            input,
            desktop,
            finished: false,
        })
    }

    /// Negotiated desktop size in pixels.
    #[must_use]
    pub fn desktop_size(&self) -> (u32, u32) {
        self.desktop
    }
}

#[async_trait]
impl ProtocolEngine for RdpEngine {
    fn protocol(&self) -> Protocol {
        Protocol::Rdp
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        // A full queue means the target is not keeping up; dropping
        // input is better than stalling the whole session actor.
        match self.input.try_send(input) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!("rdp input queue full, dropping event");
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err(EngineError::Closed("rdp session ended".to_owned()))
            }
        }
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        if self.finished {
            return Ok(None);
        }
        // Cancel-safe: an mpsc receive holds no partial state.
        match self.events.recv().await {
            Some(Ok(event)) => {
                if matches!(event, TargetEvent::Disconnected { .. }) {
                    self.finished = true;
                }
                Ok(Some(event))
            }
            Some(Err(err)) => {
                self.finished = true;
                Err(err)
            }
            None => {
                self.finished = true;
                Ok(None)
            }
        }
    }

    async fn shutdown(&mut self) -> Result<(), EngineError> {
        self.finished = true;
        // Closing the input channel is the session thread's exit signal.
        let _ = self.input.send(InputEvent::Disconnect).await;
        self.events.close();
        Ok(())
    }
}

/// Owns the non-`Send` `ironrdp` state for one session.
struct RdpSession {
    framed: TokioFramed<TlsStream<TcpStream>>,
    stage: ActiveStage,
    image: DecodedImage,
    pending: VecDeque<TargetEvent>,
    width: u16,
    height: u16,
    finished: bool,
}

/// Entry point for the dedicated session thread.
async fn session_thread(
    spec: TargetSpec,
    config: RdpConfig,
    ready: oneshot::Sender<Result<(u32, u32), EngineError>>,
    events: mpsc::Sender<Result<TargetEvent, EngineError>>,
    mut input: mpsc::Receiver<InputEvent>,
) {
    let mut session = match RdpSession::connect(spec, &config).await {
        Ok(session) => session,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };

    let desktop = (u32::from(session.width), u32::from(session.height));
    if ready.send(Ok(desktop)).is_err() {
        // The caller gave up while we were connecting.
        return;
    }

    loop {
        // Drain anything the connection already produced before waiting
        // on the socket again.
        while let Some(event) = session.pending.pop_front() {
            if events.send(Ok(event)).await.is_err() {
                return;
            }
        }
        if session.finished {
            return;
        }

        tokio::select! {
            incoming = input.recv() => {
                match incoming {
                    Some(event) => {
                        if let Err(err) = session.handle_input(event).await {
                            let _ = events.send(Err(err)).await;
                            return;
                        }
                    }
                    None => return,
                }
            }
            outcome = session.pump() => {
                if let Err(err) = outcome {
                    let _ = events.send(Err(err)).await;
                    return;
                }
            }
        }
    }
}

impl RdpSession {
    /// Connect, authenticate over CredSSP, and reach the active stage.
    async fn connect(spec: TargetSpec, config: &RdpConfig) -> Result<Self, EngineError> {
        let TargetSpec {
            hostname,
            port,
            username,
            secret,
            width,
            height,
            ..
        } = spec;

        let width = clamp_dimension(width);
        let height = clamp_dimension(height);

        let connector_config = ConnectorConfig {
            desktop_size: DesktopSize { width, height },
            // Advertise *only* CredSSP. Offering the legacy TLS security
            // layer as well lets the server negotiate down to it, and on
            // that layer the connection succeeds before any credential
            // is checked — authentication moves to an in-session login
            // screen. A live test against xrdp caught exactly that: a
            // deliberately wrong password produced a healthy session.
            // For a privileged-access gateway the connection must fail
            // closed when the target will not do NLA.
            enable_tls: false,
            enable_credssp: true,
            credentials: Credentials::UsernamePassword {
                username: username.clone(),
                password: secret.expose_secret().to_owned(),
            },
            domain: config.domain.clone(),
            client_name: config.client_name.clone(),
            keyboard_layout: config.keyboard_layout,
            // RDP delivers the mouse pointer out of band rather than
            // drawing it into the framebuffer. Wire Compatibility Mode
            // has no cursor layer yet, so have ironrdp composite the
            // pointer into the image instead — without this the operator
            // sees no cursor at all.
            enable_server_pointer: true,
            pointer_software_rendering: true,
            ..default_connector_config()
        };
        // Nothing below may observe the credential.
        drop(secret);

        let stream = TcpStream::connect((hostname.as_str(), port))
            .await
            .map_err(EngineError::Transport)?;
        // The Client Info PDU carries our own address; the target only
        // logs it, but ironrdp requires it up front.
        let client_addr = stream.local_addr().map_err(EngineError::Transport)?;
        let mut framed = TokioFramed::new(stream);
        let mut connector = ClientConnector::new(connector_config, client_addr);

        let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
            .await
            .map_err(map_connector)?;

        let initial = framed.into_inner_no_leftover();
        let (upgraded_stream, server_cert) = ironrdp_tls::upgrade(initial, &hostname)
            .await
            .map_err(EngineError::Transport)?;

        // CredSSP binds to the server's public key, which is what makes
        // the unverified TLS certificate above safe to accept.
        let server_public_key = server_cert
            .tbs_certificate
            .subject_public_key_info
            .subject_public_key
            .as_bytes()
            .ok_or_else(|| {
                EngineError::Protocol("server certificate has no public key bits".to_owned())
            })?
            .to_vec();

        let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
        let mut framed = TokioFramed::new(upgraded_stream);

        let connection = ironrdp_tokio::connect_finalize(
            upgraded,
            &mut framed,
            connector,
            hostname.as_str().into(),
            server_public_key,
            None,
            None,
        )
        .await
        .map_err(map_connector)?;

        let (width, height) = (
            connection.desktop_size.width,
            connection.desktop_size.height,
        );
        // RgbA32 so the framebuffer can be handed to the PNG encoder
        // without a channel swizzle per frame.
        let image = DecodedImage::new(PixelFormat::RgbA32, width, height);

        let mut pending = VecDeque::new();
        pending.push_back(TargetEvent::Resized {
            width: u32::from(width),
            height: u32::from(height),
        });

        let mut stage = ActiveStage::new(connection);
        stage.set_enable_server_pointer(true);

        Ok(Self {
            framed,
            stage,
            image,
            pending,
            width,
            height,
            finished: false,
        })
    }

    /// Turn stage outputs into client events, writing responses back.
    async fn absorb(&mut self, outputs: Vec<ActiveStageOutput>) -> Result<(), EngineError> {
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    self.framed
                        .write_all(&frame)
                        .await
                        .map_err(EngineError::Transport)?;
                }
                ActiveStageOutput::GraphicsUpdate(region) => {
                    let event = self.encode_region(&region)?;
                    self.pending.push_back(event);
                }
                ActiveStageOutput::Terminate(reason) => {
                    self.finished = true;
                    self.pending.push_back(TargetEvent::Disconnected {
                        reason: reason.to_string(),
                    });
                }
                ActiveStageOutput::DeactivateAll(_) => {
                    // A resolution change restarts the activation
                    // sequence; the next GraphicsUpdate repaints.
                    tracing::debug!("rdp server deactivated all, awaiting reactivation");
                }
                // Cursor shape and position are a Phase 3 concern: the
                // Guacamole `cursor` instruction needs the pointer
                // bitmap uploaded as its own layer.
                ActiveStageOutput::PointerDefault
                | ActiveStageOutput::PointerHidden
                | ActiveStageOutput::PointerPosition { .. }
                | ActiveStageOutput::PointerBitmap(_) => {}
            }
        }
        Ok(())
    }

    /// Crop the framebuffer to `region` and PNG-encode it.
    fn encode_region(
        &self,
        region: &ironrdp_pdu::geometry::InclusiveRectangle,
    ) -> Result<TargetEvent, EngineError> {
        let bpp = self.image.bytes_per_pixel();
        let stride = usize::from(self.image.width()) * bpp;
        let (left, top) = (usize::from(region.left), usize::from(region.top));
        let width = usize::from(region.width());
        let height = usize::from(region.height());

        let mut cropped = Vec::with_capacity(width * height * bpp);
        let data = self.image.data();
        for row in 0..height {
            let start = (top + row) * stride + left * bpp;
            let end = start + width * bpp;
            // A malformed region must not index past the framebuffer.
            let Some(slice) = data.get(start..end) else {
                return Err(EngineError::Protocol(format!(
                    "graphics update {region:?} falls outside the {}x{} framebuffer",
                    self.image.width(),
                    self.image.height()
                )));
            };
            cropped.extend_from_slice(slice);
        }

        let mut png = Vec::new();
        PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive)
            .write_image(
                &cropped,
                width as u32,
                height as u32,
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| EngineError::Protocol(format!("png encode failed: {e}")))?;

        Ok(TargetEvent::ImageUpdate {
            x: i32::from(region.left),
            y: i32::from(region.top),
            mimetype: "image/png",
            data: Bytes::from(png),
        })
    }

    async fn send_input(&mut self, events: &[FastPathInputEvent]) -> Result<(), EngineError> {
        let outputs = self
            .stage
            .process_fastpath_input(&mut self.image, events)
            .map_err(|e| EngineError::Protocol(e.to_string()))?;
        self.absorb(outputs).await
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        match input {
            InputEvent::Mouse { x, y, mask } => {
                let event = FastPathInputEvent::MouseEvent(MousePdu {
                    flags: pointer_flags(mask),
                    number_of_wheel_rotation_units: 0,
                    x_position: clamp_coord(x, self.width),
                    y_position: clamp_coord(y, self.height),
                });
                self.send_input(&[event]).await?;
            }
            InputEvent::Key { keysym, pressed } => {
                let Some(scancode) = keysym_to_scancode(keysym) else {
                    return Ok(());
                };
                let mut flags = KeyboardFlags::empty();
                if !pressed {
                    flags |= KeyboardFlags::RELEASE;
                }
                if scancode.extended {
                    flags |= KeyboardFlags::EXTENDED;
                }
                self.send_input(&[FastPathInputEvent::KeyboardEvent(flags, scancode.code)])
                    .await?;
            }
            InputEvent::Resize { width, height } => {
                let (width, height) = (clamp_dimension(width), clamp_dimension(height));
                if (width, height) == (self.width, self.height) {
                    return Ok(());
                }
                // Only targets that negotiated the Display Control
                // channel can resize; older hosts simply keep their
                // original desktop size.
                match self
                    .stage
                    .encode_resize(u32::from(width), u32::from(height), None, None)
                {
                    Some(Ok(frame)) => {
                        self.framed
                            .write_all(&frame)
                            .await
                            .map_err(EngineError::Transport)?;
                        self.width = width;
                        self.height = height;
                    }
                    Some(Err(e)) => return Err(EngineError::Protocol(e.to_string())),
                    None => tracing::debug!("target does not support dynamic resize"),
                }
            }
            InputEvent::Disconnect => {
                self.finished = true;
                self.pending.push_back(TargetEvent::Disconnected {
                    reason: "client requested disconnect".to_owned(),
                });
            }
            // Clipboard needs the CLIPRDR static channel wiring up; raw
            // text has no meaning to a graphical target.
            InputEvent::Clipboard(_) | InputEvent::Text(_) => {}
        }
        Ok(())
    }

    /// Read one PDU from the target and queue whatever it produced.
    async fn pump(&mut self) -> Result<(), EngineError> {
        let (action, payload) = match self.framed.read_pdu().await {
            Ok(pdu) => pdu,
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
                self.finished = true;
                self.pending.push_back(TargetEvent::Disconnected {
                    reason: "target closed the connection".to_owned(),
                });
                return Ok(());
            }
            Err(err) => return Err(EngineError::Transport(err)),
        };

        let outputs = match action {
            Action::FastPath | Action::X224 => self
                .stage
                .process(&mut self.image, action, &payload)
                .map_err(|e| EngineError::Protocol(e.to_string()))?,
        };
        self.absorb(outputs).await
    }
}

/// Builds [`RdpEngine`]s from a shared configuration.
pub struct RdpEngineFactory {
    config: RdpConfig,
}

impl RdpEngineFactory {
    /// Create a factory.
    #[must_use]
    pub fn new(config: RdpConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl EngineFactory for RdpEngineFactory {
    async fn connect(&self, spec: TargetSpec) -> Result<Box<dyn ProtocolEngine>, EngineError> {
        if spec.protocol != Protocol::Rdp {
            return Err(EngineError::Unsupported(spec.protocol.as_str()));
        }
        Ok(Box::new(RdpEngine::connect(spec, &self.config).await?))
    }
}

/// Map a Guacamole button mask onto RDP pointer flags.
fn pointer_flags(mask: u8) -> PointerFlags {
    let mut flags = PointerFlags::MOVE;
    if mask & 0x01 != 0 {
        flags |= PointerFlags::LEFT_BUTTON | PointerFlags::DOWN;
    }
    if mask & 0x04 != 0 {
        flags |= PointerFlags::RIGHT_BUTTON | PointerFlags::DOWN;
    }
    if mask & 0x02 != 0 {
        flags |= PointerFlags::MIDDLE_BUTTON_OR_WHEEL | PointerFlags::DOWN;
    }
    flags
}

/// RDP desktop dimensions are 16-bit and must be even.
fn clamp_dimension(value: u32) -> u16 {
    let clamped = value.clamp(200, 4096) as u16;
    clamped & !1
}

fn clamp_coord(value: i32, max: u16) -> u16 {
    value.clamp(0, i32::from(max.saturating_sub(1))) as u16
}

fn default_connector_config() -> ConnectorConfig {
    ConnectorConfig {
        desktop_size: DesktopSize {
            width: 1024,
            height: 768,
        },
        desktop_scale_factor: 0,
        enable_tls: true,
        enable_credssp: true,
        credentials: Credentials::UsernamePassword {
            username: String::new(),
            password: String::new(),
        },
        domain: None,
        client_build: 0,
        client_name: "strata".to_owned(),
        keyboard_type: ironrdp_pdu::gcc::KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: String::new(),
        platform: ironrdp_pdu::rdp::capability_sets::MajorPlatformType::UNIX,
        hardware_id: None,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: Default::default(),
        enable_server_pointer: false,
        pointer_software_rendering: false,
    }
}

fn map_connector(err: ironrdp_connector::ConnectorError) -> EngineError {
    let text = err.to_string();
    // CredSSP failures are the common operator-facing case and deserve
    // to be named rather than surfacing as "connection sequence failed".
    if text.contains("CredSSP") || text.contains("credssp") || text.contains("logon") {
        return EngineError::AuthRejected;
    }
    EngineError::Protocol(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_dimensions_are_clamped_and_even() {
        // RDP rejects odd widths on several codec paths.
        assert_eq!(clamp_dimension(1921), 1920);
        assert_eq!(clamp_dimension(1920), 1920);
        // Below the RDP minimum, and above what a 16-bit field holds.
        assert_eq!(clamp_dimension(0), 200);
        assert_eq!(clamp_dimension(100_000), 4096);
    }

    #[test]
    fn pointer_coordinates_stay_inside_the_desktop() {
        assert_eq!(clamp_coord(-5, 1920), 0);
        assert_eq!(clamp_coord(0, 1920), 0);
        assert_eq!(clamp_coord(5000, 1920), 1919);
    }

    #[test]
    fn a_bare_move_carries_no_button() {
        let flags = pointer_flags(0);
        assert!(flags.contains(PointerFlags::MOVE));
        assert!(!flags.contains(PointerFlags::DOWN));
        assert!(!flags.contains(PointerFlags::LEFT_BUTTON));
    }

    #[test]
    fn guacamole_button_bits_map_to_rdp_buttons() {
        // Guacamole: bit 0 left, bit 1 middle, bit 2 right.
        let left = pointer_flags(0x01);
        assert!(left.contains(PointerFlags::LEFT_BUTTON | PointerFlags::DOWN));

        let right = pointer_flags(0x04);
        assert!(right.contains(PointerFlags::RIGHT_BUTTON | PointerFlags::DOWN));
        assert!(!right.contains(PointerFlags::LEFT_BUTTON));

        let middle = pointer_flags(0x02);
        assert!(middle.contains(PointerFlags::MIDDLE_BUTTON_OR_WHEEL | PointerFlags::DOWN));
    }

    #[tokio::test]
    async fn the_factory_refuses_protocols_it_does_not_speak() {
        use secrecy::SecretString;

        let factory = RdpEngineFactory::new(RdpConfig::default());
        let spec = TargetSpec {
            protocol: Protocol::Ssh,
            hostname: "host.internal".to_owned(),
            port: 22,
            username: "admin".to_owned(),
            secret: SecretString::from("secret"),
            width: 1024,
            height: 768,
        };
        assert!(matches!(
            factory.connect(spec).await,
            Err(EngineError::Unsupported("ssh"))
        ));
    }
}
