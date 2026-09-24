//! VNC engine, replacing guacd's libvncclient path.
//!
//! Also the transport behind the `web` protocol, which runs a browser in
//! a container and exposes it over RFB, so this engine covers two of the
//! protocols that kept guacd in the deployment.
//!
//! RFB is request-driven in a way RDP is not: the server sends nothing
//! until asked, so the engine keeps a framebuffer request outstanding.
//! Forgetting that produces a session that connects, paints once, and
//! then appears frozen.

use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ColorType, ImageEncoder};
use secrecy::ExposeSecret;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
// The crate is published as `vnc-rs` but its lib target is `vnc`.
use vnc::{
    ClientKeyEvent, ClientMouseEvent, PixelFormat, VncClient, VncConnector, VncEncoding, VncEvent,
    X11Event,
};

use crate::engine::{
    DisconnectCause, EngineFactory, InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec,
};
use crate::error::EngineError;

/// Per-connection VNC settings.
#[derive(Debug, Clone, Default)]
pub struct VncConfig {
    /// Drop every keyboard and pointer event from the client.
    pub read_only: bool,
    /// Never carry the target's clipboard back to the client.
    pub disable_copy: bool,
    /// Never carry the client's clipboard to the target.
    pub disable_paste: bool,
    /// Real target behind a VNC repeater, which the engine names to the
    /// repeater rather than dialling directly.
    pub dest_host: Option<String>,
    /// Port of the real target behind the repeater.
    pub dest_port: Option<u16>,
    /// Wait for the server to dial in instead of dialling out.
    pub reverse_connect: bool,
    /// How long to wait for that inbound connection.
    pub listen_timeout: Duration,
    /// Encoding for clipboard text sent to the target.
    pub clipboard_encoding: ClipboardEncoding,
}

/// Encodings this engine can put on the wire.
///
/// guacd also offers UTF-16, CP1252 and MacRoman. None of those can be
/// expressed here: the crate's `CopyText` takes a `String`, so every byte
/// it writes is valid UTF-8 by construction, and producing arbitrary
/// bytes would need either an upstream change or undefined behaviour.
/// Connections asking for one stay on guacd.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ClipboardEncoding {
    /// What the RFB specification mandates, and guacd's default.
    #[default]
    Latin1,
    /// What guacd sends when an administrator asks for UTF-8.
    Utf8,
}

/// Render clipboard text for the wire.
///
/// For Latin-1 only the ASCII subset can be produced, because bytes
/// above 0x7F cannot appear in a Rust `String` on their own. Characters
/// outside it become `?` rather than their UTF-8 bytes: a server reading
/// Latin-1 would otherwise render `é` as `Ã©`, and silently pasting two
/// wrong characters into a shell is worse than pasting an obviously
/// missing one.
fn encode_clipboard(text: &str, encoding: ClipboardEncoding) -> String {
    match encoding {
        ClipboardEncoding::Utf8 => text.to_owned(),
        ClipboardEncoding::Latin1 => text
            .chars()
            .map(|c| if c.is_ascii() { c } else { '?' })
            .collect(),
    }
}

/// Bytes a repeater expects, and the field is fixed-width.
const REPEATER_TOKEN_BYTES: usize = 250;

/// Default wait for a reverse connection, matching guacd.
pub const DEFAULT_LISTEN_TIMEOUT: Duration = Duration::from_secs(5);

/// Builds [`VncEngine`]s from a shared configuration.
pub struct VncEngineFactory {
    config: Arc<VncConfig>,
}

impl VncEngineFactory {
    /// Create a factory with the given configuration.
    #[must_use]
    pub fn new(config: VncConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }
}

#[async_trait]
impl EngineFactory for VncEngineFactory {
    async fn connect(&self, spec: TargetSpec) -> Result<Box<dyn ProtocolEngine>, EngineError> {
        let engine = VncEngine::connect(spec, Arc::clone(&self.config)).await?;
        Ok(Box::new(engine))
    }
}

/// A live VNC session.
pub struct VncEngine {
    client: VncClient,
    config: Arc<VncConfig>,
    /// Events produced while decoding one server update.
    pending: VecDeque<TargetEvent>,
    width: u16,
    height: u16,
    /// Set once the session has ended, so the actor is told exactly once.
    finished: bool,
}

impl VncEngine {
    /// Connect and authenticate.
    async fn connect(spec: TargetSpec, config: Arc<VncConfig>) -> Result<Self, EngineError> {
        let stream = open_socket(&spec, &config).await?;

        // VNC authentication is a password with no username, and the
        // callback is a future rather than a closure, so the credential is
        // moved in and dropped with it.
        let password = spec.secret.expose_secret().to_owned();
        let client = VncConnector::new(stream)
            .set_auth_method(async move { Ok(password) })
            .allow_shared(true)
            // RGBA so a rect can go to the PNG encoder without a swizzle.
            .set_pixel_format(PixelFormat::rgba())
            // Ordered by preference. Tight and ZRLE cost the target some
            // CPU and save a great deal of bandwidth; Raw is the fallback
            // every server implements.
            .add_encoding(VncEncoding::Tight)
            .add_encoding(VncEncoding::Zrle)
            .add_encoding(VncEncoding::Trle)
            .add_encoding(VncEncoding::CopyRect)
            .add_encoding(VncEncoding::Raw)
            // The pointer is drawn by the client rather than composited
            // into the framebuffer, for the same reason as RDP: otherwise
            // every mouse move costs an image update.
            .add_encoding(VncEncoding::CursorPseudo)
            .add_encoding(VncEncoding::DesktopSizePseudo)
            .build()
            .map_err(map_vnc)?
            .try_start()
            .await
            .map_err(map_vnc)?
            .finish()
            .map_err(map_vnc)?;

        let engine = Self {
            client,
            config,
            pending: VecDeque::new(),
            width: 0,
            height: 0,
            finished: false,
        };

        // Nothing arrives until the first request, and it must be a full
        // one: an incremental update against a framebuffer the client has
        // never seen returns nothing at all.
        engine
            .client
            .input(X11Event::FullRefresh)
            .await
            .map_err(map_vnc)?;
        Ok(engine)
    }

    /// Turn one server event into client events.
    fn absorb(&mut self, event: VncEvent) {
        match event {
            VncEvent::SetResolution(screen) => {
                self.width = screen.width;
                self.height = screen.height;
                self.pending.push_back(TargetEvent::Resized {
                    width: u32::from(screen.width),
                    height: u32::from(screen.height),
                });
            }
            // Advisory: the format was requested at connect time and the
            // decoder already honours it.
            VncEvent::SetPixelFormat(_) => {}
            VncEvent::RawImage(rect, data) => {
                if let Some(png) = encode_png(rect.width, rect.height, &data) {
                    self.pending.push_back(TargetEvent::ImageUpdate {
                        x: i32::from(rect.x),
                        y: i32::from(rect.y),
                        mimetype: "image/png",
                        data: png,
                    });
                }
            }
            // Already compressed by the target, so it is forwarded as it
            // arrived. Decoding it here only to re-encode would cost CPU
            // and quality for nothing.
            VncEvent::JpegImage(rect, data) => {
                self.pending.push_back(TargetEvent::ImageUpdate {
                    x: i32::from(rect.x),
                    y: i32::from(rect.y),
                    mimetype: "image/jpeg",
                    data: Bytes::from(data),
                });
            }
            // The server said explicitly that this region moved, which is
            // the case the RDP engine could only have guessed at.
            VncEvent::Copy(dst, src) => {
                self.pending.push_back(TargetEvent::CopyRegion {
                    src_x: i32::from(src.x),
                    src_y: i32::from(src.y),
                    width: u32::from(src.width),
                    height: u32::from(src.height),
                    dst_x: i32::from(dst.x),
                    dst_y: i32::from(dst.y),
                });
            }
            VncEvent::SetCursor(rect, data) => {
                // A zero-sized cursor is how RFB says "hide the pointer".
                if rect.width == 0 || rect.height == 0 {
                    self.pending.push_back(TargetEvent::CursorHidden);
                } else if let Some(png) = encode_cursor_png(rect.width, rect.height, &data) {
                    self.pending.push_back(TargetEvent::CursorImage {
                        hotspot_x: u32::from(rect.x),
                        hotspot_y: u32::from(rect.y),
                        width: u32::from(rect.width),
                        height: u32::from(rect.height),
                        mimetype: "image/png",
                        data: png,
                    });
                }
            }
            VncEvent::Text(text) => {
                if !self.config.disable_copy {
                    self.pending
                        .push_back(TargetEvent::Clipboard(Bytes::from(text)));
                }
            }
            // An audible bell has nowhere to go in the Guacamole protocol.
            VncEvent::Bell => {}
            VncEvent::Error(message) => {
                self.pending.push_back(TargetEvent::Disconnected {
                    reason: format!("The VNC server connection failed: {message}"),
                    cause: DisconnectCause::ConnectionLost,
                });
                self.finished = true;
            }
            // The event type is non-exhaustive, so a newer decoder can
            // produce something this engine predates. Logged rather than
            // dropped silently, because the symptom would be a region
            // that never repaints.
            other => tracing::debug!(?other, "unhandled vnc event"),
        }
    }
}

#[async_trait]
impl ProtocolEngine for VncEngine {
    fn protocol(&self) -> Protocol {
        Protocol::Vnc
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        if self.config.read_only
            && !matches!(input, InputEvent::Disconnect | InputEvent::Resize { .. })
        {
            return Ok(());
        }
        match input {
            InputEvent::Key { keysym, pressed } => {
                self.client
                    .input(X11Event::KeyEvent(ClientKeyEvent {
                        keycode: keysym,
                        down: pressed,
                    }))
                    .await
                    .map_err(map_vnc)?;
            }
            InputEvent::Mouse { x, y, mask } => {
                self.client
                    .input(X11Event::PointerEvent(ClientMouseEvent {
                        position_x: clamp_coord(x),
                        position_y: clamp_coord(y),
                        bottons: mask,
                    }))
                    .await
                    .map_err(map_vnc)?;
            }
            InputEvent::Clipboard(data) | InputEvent::Text(data) => {
                if self.config.disable_paste {
                    return Ok(());
                }
                let text = String::from_utf8_lossy(&data);
                self.client
                    .input(X11Event::CopyText(encode_clipboard(
                        &text,
                        self.config.clipboard_encoding,
                    )))
                    .await
                    .map_err(map_vnc)?;
            }
            // The desktop size is the server's to choose. RFB has an
            // extension for asking, which this client does not expose, so
            // the browser scales instead.
            InputEvent::Resize { .. } => {}
            // Handled by the SFTP decorator, which sits above this engine.
            InputEvent::File(_) => {}
            InputEvent::Disconnect => {
                self.finished = true;
                let _ = self.client.close().await;
            }
        }
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.finished {
                return Ok(None);
            }

            let event = self.client.recv_event().await.map_err(map_vnc)?;
            self.absorb(event);
            // Take whatever else already arrived rather than asking again
            // per rectangle.
            while let Some(event) = self.client.poll_event().await.map_err(map_vnc)? {
                self.absorb(event);
            }

            // Exactly one request per batch. Asking only after an image
            // rectangle stalls the session for good the first time an
            // update carries nothing but a cursor change, which is what
            // happens the moment the pointer crosses a link.
            if !self.finished {
                self.client
                    .input(X11Event::Refresh)
                    .await
                    .map_err(map_vnc)?;
            }
        }
    }

    async fn shutdown(&mut self) -> Result<(), EngineError> {
        // Best effort: a target that has already gone must not stop the
        // session tearing down.
        if let Err(err) = self.client.close().await {
            tracing::debug!(error = %err, "vnc close failed");
        }
        Ok(())
    }
}

/// Obtain the socket the RFB handshake will run over.
///
/// Three shapes: dial the target, dial a repeater and name the target to
/// it, or wait for the target to dial us.
async fn open_socket(spec: &TargetSpec, config: &VncConfig) -> Result<TcpStream, EngineError> {
    if config.reverse_connect {
        return accept_reverse(spec.port, config.listen_timeout).await;
    }

    let mut stream = TcpStream::connect((spec.dial_host().as_str(), spec.port))
        .await
        .map_err(EngineError::Transport)?;

    if let Some(host) = config.dest_host.as_ref().filter(|h| !h.trim().is_empty()) {
        let port = config.dest_port.unwrap_or(spec.port);
        // The repeater reads a fixed-width field before anything else; a
        // short write leaves it waiting and the session simply hangs.
        stream
            .write_all(&repeater_token(host, port))
            .await
            .map_err(EngineError::Transport)?;
    }
    Ok(stream)
}

/// Wait for the target to connect to us.
async fn accept_reverse(port: u16, timeout: Duration) -> Result<TcpStream, EngineError> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))
        .await
        .map_err(EngineError::Transport)?;
    tracing::info!(port, "waiting for a reverse vnc connection");

    match tokio::time::timeout(timeout, listener.accept()).await {
        Ok(Ok((stream, peer))) => {
            tracing::info!(%peer, "accepted a reverse vnc connection");
            Ok(stream)
        }
        Ok(Err(err)) => Err(EngineError::Transport(err)),
        Err(_) => Err(EngineError::Protocol(format!(
            "no reverse VNC connection arrived on port {port} within {}s",
            timeout.as_secs()
        ))),
    }
}

/// Build the fixed-width field naming the real target to a repeater.
///
/// Truncated rather than refused when it will not fit: the field has no
/// length prefix, so writing more than 250 bytes would push the excess
/// into the RFB handshake and desynchronise it.
fn repeater_token(host: &str, port: u16) -> [u8; REPEATER_TOKEN_BYTES] {
    let mut token = [0u8; REPEATER_TOKEN_BYTES];
    let target = format!("{host}:{port}");
    let bytes = target.as_bytes();
    // One byte short of the field so the value always stays terminated.
    let len = bytes.len().min(REPEATER_TOKEN_BYTES - 1);
    if len < bytes.len() {
        tracing::warn!(%host, port, "repeater target was truncated to fit the field");
    }
    token[..len].copy_from_slice(&bytes[..len]);
    token
}

/// PNG-encode a framebuffer rectangle.
///
/// The fourth byte of each pixel is padding, not alpha: the negotiated
/// format is 32 bits per pixel at a depth of 24. Encoding it as alpha
/// makes the whole desktop transparent, which reaches the browser as a
/// blank page rather than as an error.
///
/// Returns `None` rather than erroring: one rectangle that will not
/// encode is a dropped update, not a dead session.
fn encode_png(width: u16, height: u16, pixels: &[u8]) -> Option<Bytes> {
    let expected = rect_len(width, height, pixels)?;
    let (pixels, _) = pixels[..expected].as_chunks::<4>();
    let mut rgb = Vec::with_capacity(pixels.len() * 3);
    for pixel in pixels {
        rgb.extend_from_slice(&pixel[..3]);
    }
    encode(&rgb, width, height, ColorType::Rgb8)
}

/// PNG-encode a cursor rectangle.
///
/// Unlike the framebuffer, a cursor really does carry alpha: the decoder
/// expands the RFB bitmask into the fourth byte, and it is what makes
/// the pointer the right shape instead of a rectangle.
fn encode_cursor_png(width: u16, height: u16, rgba: &[u8]) -> Option<Bytes> {
    let expected = rect_len(width, height, rgba)?;
    encode(&rgba[..expected], width, height, ColorType::Rgba8)
}

/// Byte length of a rectangle, or `None` if the buffer is short.
fn rect_len(width: u16, height: u16, pixels: &[u8]) -> Option<usize> {
    let expected = usize::from(width) * usize::from(height) * 4;
    if width == 0 || height == 0 || pixels.len() < expected {
        tracing::warn!(
            width,
            height,
            got = pixels.len(),
            expected,
            "vnc rectangle was smaller than its dimensions claim"
        );
        return None;
    }
    Some(expected)
}

fn encode(pixels: &[u8], width: u16, height: u16, colour: ColorType) -> Option<Bytes> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(pixels, u32::from(width), u32::from(height), colour.into())
        .ok()?;
    Some(Bytes::from(out))
}

/// Clamp a pointer coordinate into the range RFB can carry.
///
/// Coordinates are unsigned 16-bit on the wire, and a negative one from a
/// pointer dragged off the top-left would otherwise wrap to the far edge.
fn clamp_coord(value: i32) -> u16 {
    u16::try_from(value.clamp(0, i32::from(u16::MAX))).unwrap_or(0)
}

fn map_vnc(err: vnc::VncError) -> EngineError {
    EngineError::Protocol(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rectangle_shorter_than_its_dimensions_is_dropped() {
        // A truncated rect would otherwise index past the buffer.
        assert!(encode_png(4, 4, &[0u8; 8]).is_none());
    }

    #[test]
    fn an_empty_rectangle_is_dropped() {
        assert!(encode_png(0, 0, &[]).is_none());
        assert!(encode_png(4, 0, &[]).is_none());
    }

    #[test]
    fn a_full_rectangle_encodes() {
        let png = encode_png(2, 2, &[255u8; 16]).expect("2x2 should encode");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "not a png: {png:?}");
    }

    /// The fourth byte is padding and servers leave it at zero. Treating
    /// it as alpha encoded the entire desktop as transparent, which
    /// reached the browser as a blank white page.
    #[test]
    fn a_framebuffer_rectangle_is_opaque() {
        let pixels = [0u8; 16];
        let png = encode_png(2, 2, &pixels).expect("2x2 should encode");
        let decoded = image::load_from_memory(&png).expect("should decode");
        assert_eq!(decoded.color(), image::ColorType::Rgb8);
        assert_eq!(decoded.to_rgba8().pixels().next().unwrap()[3], 255);
    }

    /// A cursor's fourth byte really is alpha, and dropping it would draw
    /// the pointer as an opaque block.
    #[test]
    fn a_cursor_keeps_its_transparency() {
        let mut pixels = [255u8; 16];
        pixels[3] = 0;
        let png = encode_cursor_png(2, 2, &pixels).expect("2x2 should encode");
        let decoded = image::load_from_memory(&png).expect("should decode");
        assert_eq!(decoded.to_rgba8().pixels().next().unwrap()[3], 0);
    }

    #[test]
    fn a_pointer_dragged_off_screen_does_not_wrap() {
        // Casting a negative coordinate would land it at the far edge and
        // the target would see the pointer jump rather than stop.
        assert_eq!(clamp_coord(-5), 0);
        assert_eq!(clamp_coord(0), 0);
        assert_eq!(clamp_coord(1920), 1920);
        assert_eq!(clamp_coord(i32::MAX), u16::MAX);
    }

    /// The field has no length prefix, so its width is the protocol.
    #[test]
    fn a_repeater_token_is_exactly_the_field_width() {
        let token = repeater_token("desktop.internal", 5901);
        assert_eq!(token.len(), REPEATER_TOKEN_BYTES);
        assert!(token.starts_with(b"desktop.internal:5901\0"));
        assert!(token[21..].iter().all(|b| *b == 0), "field is not padded");
    }

    /// An over-long name must not push its tail into the RFB handshake.
    #[test]
    fn an_oversized_repeater_target_is_truncated_not_overflowed() {
        let token = repeater_token(&"a".repeat(400), 5900);
        assert_eq!(token.len(), REPEATER_TOKEN_BYTES);
        assert_eq!(token[REPEATER_TOKEN_BYTES - 1], 0, "value is unterminated");
    }

    /// Asserts what actually reaches the repeater, not just what the
    /// helper returns: the bytes are read back off a real socket.
    #[tokio::test]
    async fn the_repeater_is_told_the_target_before_anything_else() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let received = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; REPEATER_TOKEN_BYTES];
            tokio::io::AsyncReadExt::read_exact(&mut stream, &mut buf)
                .await
                .expect("read token");
            buf
        });

        let spec = TargetSpec {
            connect_addr: None,
            protocol: Protocol::Vnc,
            hostname: "127.0.0.1".to_owned(),
            port,
            username: String::new(),
            secret: secrecy::SecretString::from(String::new()),
            width: 800,
            height: 600,
        };
        let config = VncConfig {
            dest_host: Some("behind.repeater".to_owned()),
            dest_port: Some(5905),
            ..VncConfig::default()
        };
        let _stream = open_socket(&spec, &config).await.expect("connect");

        let token = received.await.expect("join");
        assert!(token.starts_with(b"behind.repeater:5905\0"), "{token:?}");
    }

    /// A reverse connection that never arrives must fail with a reason,
    /// not hang the session for the rest of its life.
    #[tokio::test]
    async fn a_reverse_connection_that_never_arrives_times_out() {
        let err = accept_reverse(0, Duration::from_millis(50))
            .await
            .expect_err("should have timed out");
        assert!(err.to_string().contains("reverse VNC"), "{err}");
    }

    /// A server reading Latin-1 renders UTF-8 bytes as mojibake, and two
    /// wrong characters pasted into a shell are worse than one obviously
    /// missing one.
    #[test]
    fn latin1_replaces_what_it_cannot_represent() {
        assert_eq!(encode_clipboard("cafe", ClipboardEncoding::Latin1), "cafe");
        assert_eq!(encode_clipboard("café", ClipboardEncoding::Latin1), "caf?");
        assert_eq!(encode_clipboard("→", ClipboardEncoding::Latin1), "?");
    }

    #[test]
    fn utf8_is_passed_through_unchanged() {
        for text in ["café", "→", "日本語", "plain"] {
            assert_eq!(encode_clipboard(text, ClipboardEncoding::Utf8), text);
        }
    }

    /// ASCII is the same in both, so the common case must not be touched.
    #[test]
    fn ascii_is_identical_under_either_encoding() {
        let text = "sudo systemctl restart nginx";
        assert_eq!(
            encode_clipboard(text, ClipboardEncoding::Latin1),
            encode_clipboard(text, ClipboardEncoding::Utf8)
        );
    }

    #[tokio::test]
    async fn a_reverse_connection_is_accepted() {
        // Port 0 lets the OS choose, so the test cannot collide with
        // anything already listening.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);

        let dialler = tokio::spawn(async move {
            for _ in 0..50 {
                if let Ok(stream) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
                    return Some(stream);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            None
        });

        let accepted = accept_reverse(port, Duration::from_secs(5)).await;
        assert!(accepted.is_ok(), "{:?}", accepted.err());
        assert!(dialler.await.expect("join").is_some());
    }
}
