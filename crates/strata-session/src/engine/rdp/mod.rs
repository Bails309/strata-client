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

pub mod audio;
pub mod clipboard;
pub mod kdc;
pub mod keycodes;
pub mod layouts;
pub mod tls;

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use ironrdp_cliprdr::pdu::{ClipboardFormat, ClipboardFormatId, FormatDataResponse};
use ironrdp_cliprdr::{Client as CliprdrClientRole, CliprdrClient, CliprdrSvcMessages};
use ironrdp_connector::connection_activation::{
    ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp_connector::credssp::KerberosConfig;
use ironrdp_connector::{
    BitmapConfig, ClientConnector, Config as ConnectorConfig, Credentials, DesktopSize,
};
use ironrdp_core::{IntoOwned, WriteBuf};
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_dvc::DrdynvcClient;
use ironrdp_graphics::diff::find_different_rects_sub;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::pointer::DecodedPointer;
use ironrdp_pdu::geometry::{InclusiveRectangle, Rectangle as _};
use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::PointerFlags;
use ironrdp_pdu::input::MousePdu;
use ironrdp_pdu::nego::NegoRequestData;
use ironrdp_pdu::rdp::capability_sets::client_codecs_capabilities;
use ironrdp_pdu::rdp::client_info::PerformanceFlags;
use ironrdp_pdu::rdp::headers::ShareDataPdu;
use ironrdp_pdu::rdp::refresh_rectangle::RefreshRectanglePdu;
use ironrdp_pdu::Action;
use ironrdp_rdpsnd::client::Rdpsnd;
use ironrdp_session::fast_path::ProcessorBuilder;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageOutput};
use ironrdp_tokio::{single_sequence_step, FramedWrite as _, TokioFramed};
use secrecy::ExposeSecret;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_rustls::client::TlsStream;

use crate::engine::rdp::audio::SessionAudio;
use crate::engine::rdp::clipboard::{
    decode_clipboard, encode_clipboard, preferred_text_format, ClipboardEvent, SessionClipboard,
    MAX_CLIPBOARD_BYTES,
};
use crate::engine::rdp::kdc::KdcNetworkClient;
use crate::engine::rdp::keycodes::keysym_to_scancode;
use crate::engine::{EngineFactory, InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec};
use crate::error::EngineError;
use crate::tls::CertPolicy;

/// Events buffered from the session thread before it applies backpressure.
const EVENT_QUEUE_DEPTH: usize = 256;

/// Bits per pixel requested when the connection does not say.
pub const DEFAULT_COLOR_DEPTH: u32 = 32;

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
    /// KDC address for Kerberos authentication, e.g. `tcp://dc.corp:88`.
    ///
    /// Required by targets whose domain policy refuses NTLM. Without
    /// it CredSSP can only offer NTLM, and such a target rejects the
    /// session. Mirrors guacd's `kdc-url` connection parameter.
    pub kdc_url: Option<String>,
    /// Desktop eye-candy the target may spend bandwidth on.
    pub performance: RdpPerformance,
    /// Routing token for a load-balanced RDS farm, as guacd's
    /// `load-balance-info` parameter holds it.
    pub load_balance_info: Option<String>,
    /// Drop every keyboard, mouse and paste event from the client.
    pub read_only: bool,
    /// Never carry the target's clipboard back to the client.
    pub disable_copy: bool,
    /// Never carry the client's clipboard to the target.
    pub disable_paste: bool,
    /// Bits per pixel to request, from `color-depth`.
    ///
    /// `None` keeps [`DEFAULT_COLOR_DEPTH`]. Lower depths cost fidelity
    /// but compress better, which is the only reason to set one now that
    /// the H.264 negotiation this used to gate has gone.
    pub color_depth: Option<u32>,
    /// What the connection accepts from the target's TLS certificate.
    ///
    /// Most RDP hosts are self-signed, so plain system-store
    /// verification needs the signing CA installed. The other two arms
    /// exist for that case: attach the issuing CA to the connection, or
    /// pin the certificate's fingerprint directly.
    pub cert_policy: CertPolicy,
}

/// Desktop features the target may enable, mirroring guacd's
/// `enable-*` connection parameters. All off by default: each one costs
/// bandwidth, which is why guacd disables them unless asked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RdpPerformance {
    /// `enable-wallpaper`.
    pub wallpaper: bool,
    /// `enable-theming`.
    pub theming: bool,
    /// `enable-font-smoothing`.
    pub font_smoothing: bool,
    /// `enable-full-window-drag`.
    pub full_window_drag: bool,
    /// `enable-desktop-composition`.
    pub desktop_composition: bool,
    /// `enable-menu-animations`.
    pub menu_animations: bool,
}

impl RdpPerformance {
    fn to_flags(self) -> PerformanceFlags {
        // The wire format is expressed as opt-outs, so an unset option
        // has to be translated into an explicit DISABLE_ bit.
        let mut flags = PerformanceFlags::empty();
        if !self.wallpaper {
            flags |= PerformanceFlags::DISABLE_WALLPAPER;
        }
        if !self.theming {
            flags |= PerformanceFlags::DISABLE_THEMING;
        }
        if !self.full_window_drag {
            flags |= PerformanceFlags::DISABLE_FULLWINDOWDRAG;
        }
        if !self.menu_animations {
            flags |= PerformanceFlags::DISABLE_MENUANIMATIONS;
        }
        if self.font_smoothing {
            flags |= PerformanceFlags::ENABLE_FONT_SMOOTHING;
        }
        if self.desktop_composition {
            flags |= PerformanceFlags::ENABLE_DESKTOP_COMPOSITION;
        }
        flags
    }
}

impl Default for RdpConfig {
    fn default() -> Self {
        Self {
            client_name: "strata".to_owned(),
            keyboard_layout: 0x0409,
            domain: None,
            kdc_url: None,
            performance: RdpPerformance::default(),
            load_balance_info: None,
            read_only: false,
            disable_copy: false,
            disable_paste: false,
            color_depth: None,
            cert_policy: CertPolicy::default(),
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

/// Wheel rotation per notch, as defined by RDP.
const WHEEL_UNITS: i16 = 120;

/// How often the encoder reports what it has been sending.
const ENCODE_REPORT_INTERVAL: Duration = Duration::from_secs(30);

/// Running totals behind the bytes-per-pixel figure.
///
/// Bytes per pixel separates the two reasons an engine ships too much:
/// an expensive codec shows up as a high ratio, redundant damage as a
/// high pixel count for the same visible work. Measured here it was the
/// second, which is why the region codec is not worth tuning.
#[derive(Debug, Default)]
struct EncodeStats {
    updates: u64,
    /// Pixels the target's damage rectangles covered.
    offered_pixels: u64,
    /// Pixels actually encoded after diffing.
    pixels: u64,
    bytes: u64,
}

impl EncodeStats {
    fn record(&mut self, pixels: usize, bytes: usize) {
        self.updates += 1;
        self.pixels += pixels as u64;
        self.bytes += bytes as u64;
    }

    fn offer(&mut self, pixels: usize) {
        self.offered_pixels += pixels as u64;
    }

    fn report(&self, screen_pixels: u64) {
        if self.pixels == 0 {
            return;
        }
        tracing::info!(
            updates = self.updates,
            megapixels = self.pixels as f64 / 1_000_000.0,
            offered_megapixels = self.offered_pixels as f64 / 1_000_000.0,
            megabytes = self.bytes as f64 / 1_048_576.0,
            bytes_per_pixel = self.bytes as f64 / self.pixels as f64,
            full_screens = self.pixels as f64 / screen_pixels.max(1) as f64,
            "rdp encoder totals"
        );
    }
}

impl Drop for RdpSession {
    fn drop(&mut self) {
        // The periodic report is no use for a short session: a minute of
        // measuring produced no summary at all.
        self.stats
            .report(u64::from(self.width) * u64::from(self.height));
    }
}

/// PNG-encode a server pointer for use as a Guacamole cursor layer.
fn encode_cursor(pointer: &DecodedPointer) -> Result<TargetEvent, EngineError> {
    let (width, height) = (u32::from(pointer.width), u32::from(pointer.height));

    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive)
        .write_image(
            &pointer.bitmap_data,
            width,
            height,
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| EngineError::Protocol(format!("cursor encode failed: {e}")))?;

    Ok(TargetEvent::CursorImage {
        hotspot_x: u32::from(pointer.hotspot_x),
        hotspot_y: u32::from(pointer.hotspot_y),
        width,
        height,
        mimetype: "image/png",
        data: Bytes::from(png),
    })
}

/// Owns the non-`Send` `ironrdp` state for one session.
struct RdpSession {
    framed: TokioFramed<TlsStream<TcpStream>>,
    stage: ActiveStage,
    image: DecodedImage,
    pending: VecDeque<TargetEvent>,
    width: u16,
    height: u16,
    /// Size we last asked the target for, to avoid re-sending it. Kept
    /// apart from `width`/`height`, which only ever track what the
    /// target actually activated.
    requested_size: Option<(u16, u16)>,
    /// Last Guacamole button mask, needed to derive press/release edges.
    mouse_mask: u8,
    clipboard: mpsc::UnboundedReceiver<ClipboardEvent>,
    /// Wave packets from the target, bounded so a stalled browser cannot
    /// grow the session.
    audio: mpsc::Receiver<Bytes>,
    /// What the operator last copied, held until the target pastes.
    local_clipboard: Option<String>,
    /// Format we last asked the target for, needed to decode its reply.
    pending_paste: Option<ClipboardFormatId>,
    /// Drop every keyboard, mouse and paste event from the client.
    read_only: bool,
    /// Never carry the target's clipboard back to the client.
    disable_copy: bool,
    /// Never carry the client's clipboard to the target.
    disable_paste: bool,
    /// Previous frame, for narrowing the target's coarse damage rects.
    shadow: Vec<u8>,
    stats: EncodeStats,
    stats_reported_at: Instant,
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
        let dial_host = spec.dial_host();
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
            performance_flags: config.performance.to_flags(),
            // Left unset, ironrdp advertises RemoteFX, a lossy wavelet, and
            // the target may then degrade the desktop before our lossless
            // encoder ever sees it. Measured against this pilot host the
            // server never took the offer up — bytes per pixel did not move
            // when it was withdrawn — so this buys fidelity we were already
            // getting rather than fidelity we had lost. It stays because a
            // gateway should not offer a lossy path it does not want, not
            // because it fixed anything observable.
            bitmap: Some(BitmapConfig {
                lossy_compression: false,
                color_depth: config.color_depth.unwrap_or(DEFAULT_COLOR_DEPTH),
                codecs: client_codecs_capabilities(&["remotefx:off"])
                    .expect("a fixed codec list cannot fail to parse"),
            }),
            // The pointer is forwarded as its own cursor layer rather
            // than drawn into the framebuffer: compositing costs an
            // image update per mouse move and trails wherever one is
            // missed.
            enable_server_pointer: true,
            pointer_software_rendering: false,
            // A load-balanced RDS farm reads this from the X.224
            // connection request and redirects to the session host
            // holding the user's disconnected session. Without it the
            // broker hands out whichever host it likes and a
            // reconnecting user gets a new desktop instead of theirs.
            request_data: config
                .load_balance_info
                .as_ref()
                .map(|token| NegoRequestData::routing_token(token.clone())),
            ..default_connector_config()
        };
        // Nothing below may observe the credential.
        drop(secret);

        let stream = TcpStream::connect((dial_host.as_str(), port))
            .await
            .map_err(EngineError::Transport)?;
        // The Client Info PDU carries our own address; the target only
        // logs it, but ironrdp requires it up front.
        let client_addr = stream.local_addr().map_err(EngineError::Transport)?;
        let mut framed = TokioFramed::new(stream);
        let (clipboard_tx, clipboard) = mpsc::unbounded_channel();
        let (audio_tx, audio) = audio::channel();
        let mut connector = ClientConnector::new(connector_config, client_addr)
            .with_static_channel(
                // Carries MS-RDPEDISP, which lets the desktop follow the
                // browser window instead of being scaled to fit it.
                DrdynvcClient::new()
                    .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new()))),
            )
            .with_static_channel(CliprdrClient::new(Box::new(SessionClipboard::new(
                clipboard_tx,
            ))))
            .with_static_channel(Rdpsnd::new(Box::new(SessionAudio::new(audio_tx))));

        let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
            .await
            .map_err(map_connector)?;

        let initial = framed.into_inner_no_leftover();
        let (upgraded_stream, server_cert) = tls::upgrade(initial, &hostname, &config.cert_policy)
            .await
            .map_err(EngineError::Transport)?;

        // CredSSP binds to the server's public key, which is what keeps
        // an unverified certificate usable when the connection opted out
        // of checking it.
        // codeql[rust/cleartext-logging] Server public key bits from X.509 certificate are public metadata, not secrets.
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

        let kerberos = config
            .kdc_url
            .clone()
            .map(|kdc_url| KerberosConfig::new(Some(kdc_url), Some(hostname.clone())))
            .transpose()
            .map_err(map_connector)?;
        let mut network_client = KdcNetworkClient;
        let network_client = kerberos
            .as_ref()
            .map(|_| &mut network_client as &mut dyn ironrdp_tokio::AsyncNetworkClient);

        let connection = ironrdp_tokio::connect_finalize(
            upgraded,
            &mut framed,
            connector,
            hostname.as_str().into(),
            server_public_key,
            network_client,
            kerberos,
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

        let mut session = Self {
            framed,
            stage,
            image,
            pending,
            width,
            height,
            mouse_mask: 0,
            clipboard,
            audio,
            local_clipboard: None,
            pending_paste: None,
            requested_size: None,
            read_only: config.read_only,
            disable_copy: config.disable_copy,
            disable_paste: config.disable_paste,
            shadow: Vec::new(),
            stats: EncodeStats::default(),
            stats_reported_at: Instant::now(),
            finished: false,
        };
        session.request_full_repaint().await?;
        Ok(session)
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
                    tracing::debug!(
                        left = region.left,
                        top = region.top,
                        right = region.right,
                        bottom = region.bottom,
                        "rdp graphics update"
                    );
                    for rect in self.changed_regions(&region) {
                        let event = self.encode_region(&rect)?;
                        self.pending.push_back(event);
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    self.finished = true;
                    // codeql[rust/cleartext-logging] Disconnect reason is a protocol termination code, not sensitive data.
                    self.pending.push_back(TargetEvent::Disconnected {
                        reason: reason.to_string(),
                    });
                }
                ActiveStageOutput::DeactivateAll(activation) => {
                    self.reactivate(activation).await?;
                }
                ActiveStageOutput::PointerBitmap(pointer) => {
                    self.pending.push_back(encode_cursor(&pointer)?);
                }
                ActiveStageOutput::PointerHidden => {
                    self.pending.push_back(TargetEvent::CursorHidden);
                }
                // The browser positions its own pointer, and keeps the
                // last shape until the server sends a new one.
                ActiveStageOutput::PointerDefault | ActiveStageOutput::PointerPosition { .. } => {}
            }
        }
        Ok(())
    }

    /// Run the Deactivation-Reactivation Sequence the server asked for.
    ///
    /// Windows sends this whenever the session's capabilities change —
    /// notably when the desktop replaces the logon screen. Ignoring it
    /// leaves both ends disagreeing about the capability set, and the
    /// server stops painting the desktop.
    async fn reactivate(
        &mut self,
        mut activation: Box<ConnectionActivationSequence>,
    ) -> Result<(), EngineError> {
        let mut buf = WriteBuf::new();
        loop {
            single_sequence_step(&mut self.framed, &mut *activation, &mut buf)
                .await
                .map_err(map_connector)?;

            let ConnectionActivationState::Finalized {
                io_channel_id,
                user_channel_id,
                desktop_size,
                enable_server_pointer,
                pointer_software_rendering,
            } = &activation.state
            else {
                continue;
            };

            let (width, height) = (desktop_size.width, desktop_size.height);
            self.stage.set_fastpath_processor(
                ProcessorBuilder {
                    io_channel_id: *io_channel_id,
                    user_channel_id: *user_channel_id,
                    enable_server_pointer: *enable_server_pointer,
                    pointer_software_rendering: *pointer_software_rendering,
                }
                .build(),
            );
            self.stage.set_enable_server_pointer(*enable_server_pointer);

            // Rebuilding the framebuffer blanks it, so only do so when
            // the size actually changed — otherwise a reactivation
            // would discard a desktop the server believes we still have.
            let resized = self.width != width || self.height != height;
            self.requested_size = None;
            if resized {
                self.width = width;
                self.height = height;
                self.image = DecodedImage::new(PixelFormat::RgbA32, width, height);
                // The old frame describes a screen that no longer exists.
                self.shadow.clear();
                self.pending.push_back(TargetEvent::Resized {
                    width: u32::from(width),
                    height: u32::from(height),
                });
            }

            tracing::info!(width, height, resized, "rdp reactivation complete");
            self.request_full_repaint().await?;
            return Ok(());
        }
    }

    /// Ask the server to redraw the whole desktop.
    ///
    /// A server only volunteers the regions it considers damaged, so a
    /// session attaching to an already-composed desktop would otherwise
    /// stay black until something on screen happened to move.
    async fn request_full_repaint(&mut self) -> Result<(), EngineError> {
        tracing::info!(
            width = self.width,
            height = self.height,
            "requesting full rdp repaint"
        );
        let area = InclusiveRectangle {
            left: 0,
            top: 0,
            right: self.width.saturating_sub(1),
            bottom: self.height.saturating_sub(1),
        };

        let mut buf = WriteBuf::new();
        self.stage
            .encode_static(
                &mut buf,
                ShareDataPdu::RefreshRectangle(RefreshRectanglePdu {
                    areas_to_refresh: vec![area],
                }),
            )
            .map_err(|e| EngineError::Protocol(e.to_string()))?;

        self.framed
            .write_all(buf.filled())
            .await
            .map_err(EngineError::Transport)
    }

    /// Crop the framebuffer to `region` and PNG-encode it.
    /// Narrow a coarse damage rectangle to what actually changed.
    ///
    /// ironrdp unions every rectangle in a fast-path PDU into one, so a
    /// caret top-left and a clock bottom-right arrive as a single
    /// near-full-screen update. Encoding that verbatim is what made this
    /// engine send tens of full screens a minute; comparing against the
    /// previous frame recovers the damage the target actually meant.
    fn changed_regions(&mut self, region: &InclusiveRectangle) -> Vec<InclusiveRectangle> {
        let bpp = self.image.bytes_per_pixel();
        let (image_w, image_h) = (self.image.width(), self.image.height());
        let stride = usize::from(image_w) * bpp;
        let (left, top) = (usize::from(region.left), usize::from(region.top));
        let (width, height) = (usize::from(region.width()), usize::from(region.height()));
        self.stats.offer(width * height);

        // `shadow` is moved out so the framebuffer can stay borrowed.
        let mut shadow = std::mem::take(&mut self.shadow);
        let data = self.image.data();

        // Nothing to compare against on the first frame, or after a
        // resize replaced the framebuffer.
        if shadow.len() != data.len() {
            shadow.clear();
            shadow.extend_from_slice(data);
            self.shadow = shadow;
            return vec![region.clone()];
        }

        let offset = top * stride + left * bpp;
        let changed = match data.get(offset..) {
            Some(current) => find_different_rects_sub::<4>(
                &shadow,
                stride,
                usize::from(image_w),
                usize::from(image_h),
                current,
                stride,
                width,
                height,
                left,
                top,
            ),
            // A malformed rectangle is the encoder's problem to report.
            None => {
                self.shadow = shadow;
                return vec![region.clone()];
            }
        };

        // Re-sync the whole advertised area, not just the parts that
        // differed, or the next comparison runs against stale pixels.
        for row in 0..height {
            let start = (top + row) * stride + left * bpp;
            let end = start + width * bpp;
            if let (Some(src), Some(dst)) = (data.get(start..end), shadow.get_mut(start..end)) {
                dst.copy_from_slice(src);
            }
        }
        self.shadow = shadow;

        changed
            .into_iter()
            .map(|rect| InclusiveRectangle {
                left: (left + rect.x) as u16,
                top: (top + rect.y) as u16,
                right: (left + rect.x + rect.width - 1) as u16,
                bottom: (top + rect.y + rect.height - 1) as u16,
            })
            .collect()
    }

    fn encode_region(&mut self, region: &InclusiveRectangle) -> Result<TargetEvent, EngineError> {
        let bpp = self.image.bytes_per_pixel();
        let stride = usize::from(self.image.width()) * bpp;
        let (left, top) = (usize::from(region.left), usize::from(region.top));
        let width = usize::from(region.width());
        let height = usize::from(region.height());

        let mut cropped = Vec::with_capacity(width * height * 3);
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
            push_rgb(slice, &mut cropped);
        }

        let pixels = width * height;
        let mut encoded = Vec::new();
        // PNG, not JPEG: a desktop is flat UI, which PNG compresses far
        // better than a DCT codec. Measured on a real session, JPEG at
        // quality 90 cost more bytes for the same activity.
        PngEncoder::new_with_quality(&mut encoded, CompressionType::Fast, FilterType::Adaptive)
            .write_image(
                &cropped,
                width as u32,
                height as u32,
                ExtendedColorType::Rgb8,
            )
            .map_err(|e| EngineError::Protocol(format!("png encode failed: {e}")))?;

        self.stats.record(pixels, encoded.len());
        if self.stats_reported_at.elapsed() >= ENCODE_REPORT_INTERVAL {
            self.stats
                .report(u64::from(self.width) * u64::from(self.height));
            self.stats_reported_at = Instant::now();
        }

        Ok(TargetEvent::ImageUpdate {
            x: i32::from(region.left),
            y: i32::from(region.top),
            mimetype: "image/png",
            data: Bytes::from(encoded),
        })
    }

    /// Queue whatever audio arrived while decoding the last PDU.
    ///
    /// Drained rather than selected on for the same reason as the
    /// clipboard: the backend only emits from inside
    /// `ActiveStage::process`.
    fn drain_audio(&mut self) {
        while let Ok(wave) = self.audio.try_recv() {
            self.pending.push_back(TargetEvent::Audio(wave));
        }
    }

    /// Act on everything the clipboard channel produced while decoding.
    ///
    /// Drained after each PDU rather than selected on, because the
    /// backend only ever emits from inside `ActiveStage::process`.
    async fn drain_clipboard(&mut self) -> Result<(), EngineError> {
        while let Ok(event) = self.clipboard.try_recv() {
            match event {
                ClipboardEvent::RemoteFormats(formats) => {
                    tracing::debug!(
                        formats = ?formats.iter().map(|f| f.value()).collect::<Vec<_>>(),
                        "rdp clipboard: target advertised formats"
                    );
                    if self.disable_copy {
                        // Never ask for the data: what is not requested
                        // cannot leak if a later guard is missed.
                        continue;
                    }
                    let Some(format) = preferred_text_format(&formats) else {
                        tracing::debug!("rdp clipboard: no usable text format advertised");
                        continue;
                    };
                    // Formats are only an advert; the data needs asking for.
                    let messages = self
                        .cliprdr()?
                        .initiate_paste(format)
                        .map_err(|e| EngineError::Protocol(e.to_string()))?;
                    tracing::debug!(
                        format = format.value(),
                        "rdp clipboard: requesting data from target"
                    );
                    self.pending_paste = Some(format);
                    self.write_svc(messages).await?;
                }
                ClipboardEvent::RemoteData { is_error, data } => {
                    tracing::debug!(
                        is_error,
                        len = data.len(),
                        pending = ?self.pending_paste.map(|f| f.value()),
                        "rdp clipboard: data response from target"
                    );
                    if is_error || data.len() > MAX_CLIPBOARD_BYTES {
                        if data.len() > MAX_CLIPBOARD_BYTES {
                            tracing::warn!(
                                bytes = data.len(),
                                "target clipboard payload too large; dropped"
                            );
                        }
                        continue;
                    }
                    let format = self
                        .pending_paste
                        .unwrap_or(ClipboardFormatId::CF_UNICODETEXT);
                    match decode_clipboard(format, &data) {
                        Some(text) => {
                            tracing::debug!(
                                chars = text.len(),
                                "rdp clipboard: forwarding to client"
                            );
                            self.pending.push_back(TargetEvent::Clipboard(text));
                        }
                        None => tracing::debug!(
                            format = format.value(),
                            "rdp clipboard: could not decode data response"
                        ),
                    }
                }
                ClipboardEvent::DataRequest(format) => {
                    tracing::debug!(
                        format = format.value(),
                        have_local = self.local_clipboard.is_some(),
                        "rdp clipboard: target requested our data"
                    );
                    let response = match self.local_clipboard.clone() {
                        Some(text) if !self.disable_paste => encode_clipboard(format, &text),
                        _ => FormatDataResponse::new_error(),
                    }
                    .into_owned();
                    let messages = self
                        .cliprdr()?
                        .submit_format_data(response)
                        .map_err(|e| EngineError::Protocol(e.to_string()))?;
                    self.write_svc(messages).await?;
                }
                ClipboardEvent::FormatListRequested => {
                    // MS-RDPECLIP: the server withholds its own format lists
                    // until the client answers Monitor Ready with one.
                    self.advertise_local_formats().await?;
                }
            }
        }
        Ok(())
    }

    /// Announce what we can paste into the target.
    ///
    /// An empty list is legal and means "nothing to offer yet"; it still
    /// completes the handshake that unblocks the target's own adverts.
    async fn advertise_local_formats(&mut self) -> Result<(), EngineError> {
        let formats = if self.local_clipboard.is_some() {
            vec![
                ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
                ClipboardFormat::new(ClipboardFormatId::CF_TEXT),
            ]
        } else {
            Vec::new()
        };
        let messages = self
            .cliprdr()?
            .initiate_copy(&formats)
            .map_err(|e| EngineError::Protocol(e.to_string()))?;
        self.write_svc(messages).await?;
        Ok(())
    }

    fn cliprdr(&mut self) -> Result<&CliprdrClient, EngineError> {
        self.stage
            .get_svc_processor::<CliprdrClient>()
            .ok_or_else(|| EngineError::Protocol("clipboard channel is not available".to_owned()))
    }

    async fn write_svc(
        &mut self,
        messages: CliprdrSvcMessages<CliprdrClientRole>,
    ) -> Result<(), EngineError> {
        let frame = self
            .stage
            .process_svc_processor_messages(messages)
            .map_err(|e| EngineError::Protocol(e.to_string()))?;
        self.framed
            .write_all(&frame)
            .await
            .map_err(EngineError::Transport)
    }

    async fn send_input(&mut self, events: &[FastPathInputEvent]) -> Result<(), EngineError> {
        let outputs = self
            .stage
            .process_fastpath_input(&mut self.image, events)
            .map_err(|e| EngineError::Protocol(e.to_string()))?;
        self.absorb(outputs).await
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        // Resize keeps working read-only: it only affects what this
        // viewer sees, and blocking it would leave the desktop blurred.
        if self.read_only
            && matches!(
                input,
                InputEvent::Mouse { .. } | InputEvent::Key { .. } | InputEvent::Clipboard(_)
            )
        {
            return Ok(());
        }
        match input {
            InputEvent::Mouse { x, y, mask } => {
                let events = mouse_events(
                    self.mouse_mask,
                    mask,
                    clamp_coord(x, self.width),
                    clamp_coord(y, self.height),
                )
                .into_iter()
                .map(FastPathInputEvent::MouseEvent)
                .collect::<Vec<_>>();
                self.mouse_mask = mask;
                self.send_input(&events).await?;
            }
            InputEvent::Clipboard(data) => {
                if self.disable_paste {
                    return Ok(());
                }
                if data.len() > MAX_CLIPBOARD_BYTES {
                    tracing::warn!(bytes = data.len(), "clipboard payload too large; dropped");
                    return Ok(());
                }
                let Ok(text) = String::from_utf8(data.to_vec()) else {
                    return Ok(());
                };
                self.local_clipboard = Some(text);
                // Delayed rendering: advertise only. The target asks for
                // the data if and when someone pastes.
                self.advertise_local_formats().await?;
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
                let (requested_w, requested_h) = (width, height);
                let (width, height) = (clamp_dimension(width), clamp_dimension(height));
                if u32::from(width) != requested_w || u32::from(height) != requested_h {
                    tracing::warn!(
                        requested_w,
                        requested_h,
                        width,
                        height,
                        "clamped the requested desktop size; a multi-monitor layout \
                         will not line up"
                    );
                }
                if (width, height) == (self.width, self.height)
                    || self.requested_size == Some((width, height))
                {
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
                        // Deliberately not touching `self.width`/`height`:
                        // the target picks the real size and announces it
                        // through the reactivation sequence.
                        self.requested_size = Some((width, height));
                    }
                    Some(Err(e)) => return Err(EngineError::Protocol(e.to_string())),
                    None => tracing::debug!("target does not support dynamic resize"),
                }
            }
            // Handled by the SFTP decorator, which sits above this engine.
            InputEvent::File(_) => {}
            InputEvent::Disconnect => {
                self.finished = true;
                // codeql[rust/cleartext-logging] Disconnect reason is a static event message, not sensitive data.
                self.pending.push_back(TargetEvent::Disconnected {
                    reason: "client requested disconnect".to_owned(),
                });
            }
            // Raw text has no meaning to a graphical target.
            InputEvent::Text(_) => {}
        }
        Ok(())
    }

    /// Read one PDU from the target and queue whatever it produced.
    async fn pump(&mut self) -> Result<(), EngineError> {
        let (action, payload) = match self.framed.read_pdu().await {
            Ok(pdu) => pdu,
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
                self.finished = true;
                // codeql[rust/cleartext-logging] Clean EOF disconnect notification is a static status string, not sensitive data.
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
        self.absorb(outputs).await?;
        self.drain_audio();
        self.drain_clipboard().await
    }
}

/// Append `rgba` to `out`, dropping the alpha channel.
///
/// The desktop is opaque — alpha was previously overwritten with 255
/// before encoding — so the channel carries nothing and costs the PNG
/// encoder a quarter of every pixel it reads.
fn push_rgb(rgba: &[u8], out: &mut Vec<u8>) {
    let (pixels, _) = rgba.as_chunks::<4>();
    for pixel in pixels {
        out.extend_from_slice(&pixel[..3]);
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

/// Translate a Guacamole button mask change into RDP pointer events.
///
/// Guacamole reports the button state after every change, whereas RDP is
/// edge-driven: a release is the button flag *without* `DOWN`. Sending
/// only the state leaves the button held down forever and no click ever
/// completes.
fn mouse_events(previous: u8, mask: u8, x_position: u16, y_position: u16) -> Vec<MousePdu> {
    let at = |flags, units| MousePdu {
        flags,
        number_of_wheel_rotation_units: units,
        x_position,
        y_position,
    };

    // Move first so a button lands where the operator released it.
    let mut events = vec![at(PointerFlags::MOVE, 0)];

    let buttons = [
        (0x01, PointerFlags::LEFT_BUTTON),
        (0x02, PointerFlags::MIDDLE_BUTTON_OR_WHEEL),
        (0x04, PointerFlags::RIGHT_BUTTON),
    ];
    for (bit, button) in buttons {
        let was_down = previous & bit != 0;
        let is_down = mask & bit != 0;
        if was_down == is_down {
            continue;
        }
        let flags = if is_down {
            button | PointerFlags::DOWN
        } else {
            button
        };
        events.push(at(flags, 0));
    }

    // The wheel arrives as a transient button press; RDP wants a rotation.
    for (bit, units) in [(0x08, WHEEL_UNITS), (0x10, -WHEEL_UNITS)] {
        if mask & bit != 0 && previous & bit == 0 {
            events.push(at(PointerFlags::VERTICAL_WHEEL, units));
        }
    }

    events
}

/// RDP desktop dimensions are 16-bit and must be even.
/// RDP desktop dimensions are 16-bit and must be even.
///
/// The ceiling is the MS-RDPEDISP maximum. Multi-monitor asks for the
/// aggregate width of every screen and slices it client side, so a
/// lower cap silently truncates a three-screen layout the browser then
/// slices for a width the desktop does not have.
fn clamp_dimension(value: u32) -> u16 {
    let clamped = value.clamp(200, 8192) as u16;
    clamped & !1
}

fn clamp_coord(value: i32, max: u16) -> u16 {
    value.clamp(0, i32::from(max.saturating_sub(1))) as u16
}

/// What an RDP target presented, for an operator to approve or pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredCertificate {
    /// SHA-256 of the DER, lowercase hex with `:` separators — the form
    /// `openssl x509 -fingerprint -sha256` prints and the connection
    /// editor accepts.
    pub fingerprint: String,
    /// Certificate subject, for a human to recognise the host by.
    pub subject: String,
    /// Certificate issuer. Self-signed when it matches the subject.
    pub issuer: String,
    /// Expiry, as the certificate states it.
    pub not_after: String,
    /// Whether issuer and subject match, which is the usual case for RDP.
    pub self_signed: bool,
}

/// Read the certificate an RDP target presents.
///
/// There is no way to obtain this by hand: RDP only presents its
/// certificate after the X.224 negotiation, so `openssl s_client` cannot
/// fetch one. Without this, pinning a fingerprint means provoking a
/// failed connection and reading the value out of the error, which is a
/// poor way to configure a security control.
///
/// The certificate is returned, never stored, and deliberately not
/// verified — it is fetched over the very channel it is meant to
/// protect, so it is the starting point for a human decision rather than
/// proof of anything.
pub async fn discover_certificate(
    hostname: &str,
    connect_addr: Option<std::net::IpAddr>,
    port: u16,
    timeout: Duration,
) -> Result<DiscoveredCertificate, EngineError> {
    use sha2::Digest as _;

    // Same split as a session: dial the resolved address, present the
    // name, so the certificate that comes back is the one a session
    // would be asked to trust.
    let dial_host = connect_addr.map_or_else(|| hostname.to_owned(), |ip| ip.to_string());
    let probe = async {
        let stream = TcpStream::connect((dial_host.as_str(), port))
            .await
            .map_err(EngineError::Transport)?;
        let client_addr = stream.local_addr().map_err(EngineError::Transport)?;
        let mut framed = TokioFramed::new(stream);
        let mut connector = ClientConnector::new(default_connector_config(), client_addr);

        // Only the X.224 exchange runs, which precedes authentication —
        // the blank credentials in the default config are never offered.
        let _ = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
            .await
            .map_err(map_connector)?;

        let initial = framed.into_inner_no_leftover();
        let (_stream, cert) = tls::upgrade(initial, hostname, &CertPolicy::Ignore)
            .await
            .map_err(EngineError::Transport)?;
        Ok::<_, EngineError>(cert)
    };

    let cert = tokio::time::timeout(timeout, probe).await.map_err(|_| {
        EngineError::Protocol(format!("{hostname}:{port} did not answer in time"))
    })??;

    let der = {
        use x509_cert::der::Encode as _;
        cert.to_der()
            .map_err(|e| EngineError::Protocol(format!("certificate is not encodable: {e}")))?
    };
    let subject = cert.tbs_certificate.subject.to_string();
    let issuer = cert.tbs_certificate.issuer.to_string();

    Ok(DiscoveredCertificate {
        fingerprint: crate::tls::format_fingerprint(&sha2::Sha256::digest(&der)),
        self_signed: subject == issuer,
        not_after: cert.tbs_certificate.validity.not_after.to_string(),
        subject,
        issuer,
    })
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
    fn desktop_pixels_are_encoded_without_alpha() {
        // Whatever the framebuffer holds in the fourth byte, the desktop
        // is opaque and the channel must not reach the encoder.
        let mut rgb = Vec::new();
        push_rgb(&[10, 20, 30, 0, 40, 50, 60, 127], &mut rgb);
        assert_eq!(rgb, [10, 20, 30, 40, 50, 60]);
    }

    #[test]
    fn the_target_is_never_offered_a_lossy_codec() {
        // RemoteFX is a lossy wavelet, and ironrdp advertises it unless
        // told otherwise. Accepting it costs glyph edges before our own
        // encoder is ever reached, so no session may offer it.
        let codecs = client_codecs_capabilities(&["remotefx:off"]).unwrap();
        assert!(
            codecs.0.is_empty(),
            "a codec was advertised that could return lossy pixels: {:?}",
            codecs.0
        );
    }

    #[test]
    fn unset_desktop_features_become_explicit_opt_outs() {
        // The wire format is expressed as DISABLE_ bits, so "off" is not
        // the absence of a flag and an empty set would turn everything on.
        let flags = RdpPerformance::default().to_flags();
        assert!(flags.contains(PerformanceFlags::DISABLE_WALLPAPER));
        assert!(flags.contains(PerformanceFlags::DISABLE_THEMING));
        assert!(flags.contains(PerformanceFlags::DISABLE_FULLWINDOWDRAG));
        assert!(flags.contains(PerformanceFlags::DISABLE_MENUANIMATIONS));
        assert!(!flags.contains(PerformanceFlags::ENABLE_FONT_SMOOTHING));
    }

    #[test]
    fn enabling_a_desktop_feature_clears_its_opt_out() {
        let flags = RdpPerformance {
            wallpaper: true,
            theming: true,
            font_smoothing: true,
            desktop_composition: true,
            ..RdpPerformance::default()
        }
        .to_flags();
        assert!(!flags.contains(PerformanceFlags::DISABLE_WALLPAPER));
        assert!(!flags.contains(PerformanceFlags::DISABLE_THEMING));
        assert!(flags.contains(PerformanceFlags::ENABLE_FONT_SMOOTHING));
        assert!(flags.contains(PerformanceFlags::ENABLE_DESKTOP_COMPOSITION));
        // Not asked for, so still opted out.
        assert!(flags.contains(PerformanceFlags::DISABLE_FULLWINDOWDRAG));
    }

    #[test]
    fn desktop_dimensions_are_clamped_and_even() {
        // RDP rejects odd widths on several codec paths.
        assert_eq!(clamp_dimension(1921), 1920);
        assert_eq!(clamp_dimension(1920), 1920);
        // Below the RDP minimum, and above what MS-RDPEDISP allows.
        assert_eq!(clamp_dimension(0), 200);
        assert_eq!(clamp_dimension(100_000), 8192);
        // Aggregate widths multi-monitor asks for must survive intact.
        assert_eq!(clamp_dimension(3840), 3840);
        assert_eq!(clamp_dimension(5760), 5760);
        assert_eq!(clamp_dimension(7680), 7680);
    }

    #[test]
    fn pointer_coordinates_stay_inside_the_desktop() {
        assert_eq!(clamp_coord(-5, 1920), 0);
        assert_eq!(clamp_coord(0, 1920), 0);
        assert_eq!(clamp_coord(5000, 1920), 1919);
    }

    #[test]
    fn a_bare_move_carries_no_button() {
        let events = mouse_events(0, 0, 10, 20);
        assert_eq!(events.len(), 1);
        assert!(events[0].flags.contains(PointerFlags::MOVE));
        assert!(!events[0].flags.contains(PointerFlags::DOWN));
    }

    #[test]
    fn guacamole_button_bits_map_to_rdp_buttons() {
        // Guacamole: bit 0 left, bit 1 middle, bit 2 right.
        let left = mouse_events(0, 0x01, 0, 0);
        assert!(left[1]
            .flags
            .contains(PointerFlags::LEFT_BUTTON | PointerFlags::DOWN));

        let right = mouse_events(0, 0x04, 0, 0);
        assert!(right[1]
            .flags
            .contains(PointerFlags::RIGHT_BUTTON | PointerFlags::DOWN));
        assert!(!right[1].flags.contains(PointerFlags::LEFT_BUTTON));

        let middle = mouse_events(0, 0x02, 0, 0);
        assert!(middle[1]
            .flags
            .contains(PointerFlags::MIDDLE_BUTTON_OR_WHEEL | PointerFlags::DOWN));
    }

    #[test]
    fn releasing_a_button_sends_the_button_without_down() {
        // Without this edge the server never sees the click complete.
        let events = mouse_events(0x01, 0, 0, 0);
        assert_eq!(events.len(), 2);
        assert!(events[1].flags.contains(PointerFlags::LEFT_BUTTON));
        assert!(!events[1].flags.contains(PointerFlags::DOWN));
    }

    #[test]
    fn holding_a_button_while_moving_repeats_no_edge() {
        let events = mouse_events(0x01, 0x01, 5, 5);
        assert_eq!(events.len(), 1);
        assert!(events[0].flags.contains(PointerFlags::MOVE));
    }

    #[test]
    fn the_wheel_becomes_a_rotation() {
        let up = mouse_events(0, 0x08, 0, 0);
        assert!(up[1].flags.contains(PointerFlags::VERTICAL_WHEEL));
        assert_eq!(up[1].number_of_wheel_rotation_units, WHEEL_UNITS);

        let down = mouse_events(0, 0x10, 0, 0);
        assert_eq!(down[1].number_of_wheel_rotation_units, -WHEEL_UNITS);
    }

    #[tokio::test]
    async fn the_factory_refuses_protocols_it_does_not_speak() {
        use secrecy::SecretString;

        let factory = RdpEngineFactory::new(RdpConfig::default());
        let spec = TargetSpec {
            connect_addr: None,
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
