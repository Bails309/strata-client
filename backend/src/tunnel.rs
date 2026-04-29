use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::AppError;
use crate::services::file_store::FileStore;
use crate::services::session_registry::{SessionBuffer, SessionRegistry};

/// Convert a serde_json::Value (expected to be an Object) into a flat
/// HashMap<String, String>.  Strings are kept as-is, booleans and numbers
/// are converted via `to_string()`, and all other types are skipped.
pub fn json_to_string_map(value: &serde_json::Value) -> HashMap<String, String> {
    match value {
        serde_json::Value::Object(map) => map
            .iter()
            .filter_map(|(k, v)| {
                let val = match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => return None,
                };
                Some((k.clone(), val))
            })
            .collect(),
        _ => HashMap::new(),
    }
}

/// Optional NVR context — when provided the proxy captures guacd→client
/// frames into a ring buffer and broadcasts them to admin observers.
pub struct NvrContext {
    pub registry: SessionRegistry,
    pub session_id: String,
    pub connection_id: uuid::Uuid,
    pub connection_name: String,
    pub protocol: String,
    pub user_id: uuid::Uuid,
    pub username: String,
    pub client_ip: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub db_pool: sqlx::Pool<sqlx::Postgres>,
    pub file_store: FileStore,
}

/// Parameters injected into the guacd Guacamole protocol handshake.
pub struct HandshakeParams {
    pub protocol: String,
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub domain: Option<String>,
    pub security: Option<String>,
    pub ignore_cert: bool,
    pub recording_path: Option<String>,
    pub recording_name: Option<String>,
    pub create_recording_path: bool,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    /// Additional guacd parameters from the connection's `extra` JSONB column.
    /// Keys are guacd arg names (e.g. "enable-wallpaper", "color-depth").
    pub extra: std::collections::HashMap<String, String>,
}

impl HandshakeParams {
    /// Build a lookup map of parameter name → value.
    fn param_map(&self) -> std::collections::HashMap<&str, String> {
        let mut m = std::collections::HashMap::new();
        m.insert("hostname", self.hostname.clone());
        m.insert("port", self.port.to_string());
        m.insert("width", self.width.to_string());
        m.insert("height", self.height.to_string());
        m.insert("dpi", self.dpi.to_string());
        if let Some(ref u) = self.username {
            m.insert("username", u.clone());
        }
        if let Some(ref p) = self.password {
            m.insert("password", p.clone());
        }
        if let Some(ref d) = self.domain {
            m.insert("domain", d.clone());
        }
        if let Some(ref s) = self.security {
            m.insert("security", s.clone());
        }
        if self.ignore_cert {
            m.insert("ignore-cert", "true".into());
        }
        m.insert("resize-method", "display-update".into());

        if let Some(ref rp) = self.recording_path {
            m.insert("recording-path", rp.clone());
            if let Some(ref rn) = self.recording_name {
                m.insert("recording-name", rn.clone());
            }
            if self.create_recording_path {
                m.insert("create-recording-path", "true".into());
            }
        }
        m
    }

    /// Build the full parameter map merging core fields with extra params.
    /// Extra params can override defaults (e.g. security, resize-method).
    pub fn full_param_map(&self) -> std::collections::HashMap<String, String> {
        let base = self.param_map();
        let mut m: std::collections::HashMap<String, String> =
            base.into_iter().map(|(k, v)| (k.to_string(), v)).collect();

        // RDP virtual drive — enables file transfer via RDPDR channel.
        // Only enable when the admin has explicitly set `enable-drive=true` in
        // the connection's extras.  The admin form's checkbox renders as
        // unchecked for both absent and non-"true" values, so treating absent
        // as "enabled" would diverge from what the admin sees in the UI.
        if self.protocol == "rdp" {
            let drive_enabled = self.extra.get("enable-drive").map(String::as_str) == Some("true");
            if drive_enabled {
                m.insert("enable-drive".into(), "true".into());
                m.entry("drive-path".into())
                    .or_insert_with(|| "/var/lib/guacamole/drive".into());
                m.entry("drive-name".into())
                    .or_insert_with(|| "Guacamole".into());
                m.entry("create-drive-path".into())
                    .or_insert_with(|| "true".into());
            }

            // FreeRDP 3 GFX pipeline — enables H.264 hardware/software encoding
            // for significantly lower bandwidth usage on modern RDP hosts.
            // `enable-h264` is added by guacd patch 004-h264-display-worker, and
            // activates raw H.264 NAL passthrough to the browser's WebCodecs
            // VideoDecoder, eliminating server-side decode/re-encode (and the
            // tile-cache ghosting that came with it).
            //
            // The full set below mirrors rustguac's RDP defaults verbatim
            // (sol1/rustguac src/guacd.rs handshake builder). Those defaults
            // are what actually get H.264 to flow on Windows hosts: in
            // particular `color-depth=32` is mandatory for FreeRDP to enable
            // AVC444 negotiation, and the `enable-*` toggles must be set
            // explicitly (empty != "false" everywhere in guacd's settings.c).
            m.entry("color-depth".into()).or_insert_with(|| "32".into());
            // RDPGFX (graphics pipeline) and H.264 are OPT-IN, matching rustguac's
            // per-entry defaults. Forcing them on for every RDP connection causes
            // tile-cache ghosting on Windows hosts that don't actually support
            // H.264 / AVC444 (e.g. servers without a GPU and without the AVC444
            // registry config): FreeRDP advertises the codec, the server
            // negotiates RDPGFX, then can't deliver H.264 and falls back into a
            // corrupted progressive-codec bitmap-cache state — Notepad fragments
            // bleed into Chrome, switching apps doesn't repaint cleanly, etc.
            // Per-connection extras can re-enable GFX/H.264 for servers that
            // genuinely support them.
            m.entry("disable-gfx".into())
                .or_insert_with(|| "true".into());
            m.entry("enable-h264".into())
                .or_insert_with(|| "false".into());
            m.entry("force-lossless".into())
                .or_insert_with(|| "false".into());
            m.entry("cursor".into()).or_insert_with(|| "local".into());
            m.entry("enable-wallpaper".into())
                .or_insert_with(|| "false".into());
            m.entry("enable-theming".into())
                .or_insert_with(|| "false".into());
            m.entry("enable-font-smoothing".into())
                .or_insert_with(|| "true".into());
            m.entry("enable-full-window-drag".into())
                .or_insert_with(|| "false".into());
            m.entry("enable-desktop-composition".into())
                .or_insert_with(|| "false".into());
            m.entry("enable-menu-animations".into())
                .or_insert_with(|| "false".into());
            m.entry("disable-bitmap-caching".into())
                .or_insert_with(|| "false".into());
            m.entry("disable-offscreen-caching".into())
                .or_insert_with(|| "false".into());
            m.entry("disable-audio".into())
                .or_insert_with(|| "false".into());
            m.entry("enable-audio-input".into())
                .or_insert_with(|| "false".into());
            m.entry("enable-printing".into())
                .or_insert_with(|| "false".into());
            m.entry("console".into()).or_insert_with(|| "false".into());
            m.entry("read-only".into())
                .or_insert_with(|| "false".into());
            m.entry("disable-auth".into())
                .or_insert_with(|| "false".into());

            // Increase clipboard buffer size to 8 MiB (default is often 64KB - 256KB)
            m.entry("clipboard-buffer-size".into())
                .or_insert_with(|| "8388608".into());
        }

        // SFTP for SSH connections — only when explicitly enabled in extras.
        if self.protocol == "ssh" {
            let sftp_enabled = self.extra.get("enable-sftp").map(String::as_str) == Some("true");
            if sftp_enabled {
                m.insert("enable-sftp".into(), "true".into());
            }
        }

        // Clipboard — enable for all protocols
        m.entry("disable-copy".into())
            .or_insert_with(|| "false".into());
        m.entry("disable-paste".into())
            .or_insert_with(|| "false".into());

        // Merge extra params — only allow known safe guacd parameter names.
        // This prevents injection of arbitrary protocol options.
        for (k, v) in &self.extra {
            if !v.is_empty() && is_allowed_guacd_param(k) {
                m.insert(k.clone(), v.clone());
            }
        }
        m
    }
}

/// Whitelist of guacd parameters that connections may override via `extra`.
/// Sensitive parameters (credentials, drive paths) are excluded.
fn is_allowed_guacd_param(name: &str) -> bool {
    matches!(
        name,
        "color-depth"
            | "enable-wallpaper"
            | "enable-theming"
            | "enable-font-smoothing"
            | "enable-full-window-drag"
            | "enable-desktop-composition"
            | "enable-menu-animations"
            | "enable-printing"
            | "enable-gfx"
            | "enable-h264"
            | "clipboard-buffer-size"
            | "resize-method"
            | "server-layout"
            | "console"
            | "initial-program"
            | "timezone"
            | "client-name"
            | "enable-audio"
            | "enable-audio-input"
            | "disable-audio"
            | "disable-copy"
            | "disable-paste"
            | "enable-touch"
            | "swap-red-blue"
            | "cursor"
            | "read-only"
            | "scrollback"
            | "font-name"
            | "font-size"
            | "backspace"
            | "terminal-type"
            | "typescript-path"
            | "typescript-name"
            | "create-typescript-path"
            | "wol-send-packet"
            | "wol-mac-addr"
            | "wol-broadcast-addr"
            | "wol-udp-port"
            | "wol-wait-time"
            | "force-lossless"
            | "disable-glyph-caching"
            | "disable-bitmap-caching"
            | "disable-offscreen-caching"
            | "disable-gfx"
            | "ignore-cert"
            | "auth-pkg"
            | "kdc-url"
            | "kerberos-cache"
            | "cert-tofu"
            | "cert-fingerprints"
            | "disable-auth"
            | "recording-include-keys"
            | "recording-exclude-output"
            | "recording-exclude-mouse"
            | "recording-exclude-touch"
    )
}

/// Encode a single Guacamole protocol instruction.
/// Format: <len>.<opcode>,<len>.<arg1>,<len>.<arg2>,...;
fn guac_instruction(opcode: &str, args: &[&str]) -> Vec<u8> {
    let mut parts: Vec<String> = vec![format!("{}.{}", opcode.len(), opcode)];
    for arg in args {
        parts.push(format!("{}.{}", arg.len(), arg));
    }
    let mut inst = parts.join(",");
    inst.push(';');
    inst.into_bytes()
}

/// Read a complete Guacamole protocol instruction from a TCP stream.
/// Instructions are terminated by ';'.
async fn read_instruction(
    reader: &mut (impl AsyncReadExt + Unpin),
) -> Result<(String, Vec<String>), AppError> {
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        let n = reader
            .read(&mut byte)
            .await
            .map_err(|e| AppError::Internal(format!("guacd read: {e}")))?;
        if n == 0 {
            return Err(AppError::Internal(
                "guacd closed connection during handshake".into(),
            ));
        }
        buf.push(byte[0]);
        if byte[0] == b';' {
            break;
        }
    }

    let text =
        String::from_utf8(buf).map_err(|e| AppError::Internal(format!("guacd non-utf8: {e}")))?;

    parse_instruction(&text)
}

/// Parse a Guacamole instruction string like "4.args,8.hostname,4.port;"
fn parse_instruction(raw: &str) -> Result<(String, Vec<String>), AppError> {
    let trimmed = raw.trim_end_matches(';');
    let mut elements = Vec::new();
    let mut remaining = trimmed;

    while !remaining.is_empty() {
        // Find the dot separating length from value
        let dot_pos = remaining
            .find('.')
            .ok_or_else(|| AppError::Internal(format!("bad guac instruction: {raw}")))?;
        let len: usize = remaining[..dot_pos]
            .parse()
            .map_err(|_| AppError::Internal(format!("bad guac length: {raw}")))?;

        // Guacamole lengths are in UNICODE CHARACTERS, not bytes.
        let value_start = dot_pos + 1;
        let value_pool = &remaining[value_start..];

        // Ensure the pool has at least 'len' characters
        if len > 0 && value_pool.chars().nth(len - 1).is_none() {
            return Err(AppError::Internal(format!("truncated guac element: {raw}")));
        }

        // Find the byte offset of the len-th character
        let byte_offset = value_pool
            .char_indices()
            .nth(len)
            .map(|(idx, _)| idx)
            .unwrap_or(value_pool.len());

        let value = &value_pool[..byte_offset];
        elements.push(value.to_string());

        remaining = &value_pool[byte_offset..];

        // Skip the comma separator if present
        if remaining.starts_with(',') {
            remaining = &remaining[1..];
        }
    }

    if elements.is_empty() {
        return Err(AppError::Internal(format!("empty guac instruction: {raw}")));
    }

    let opcode = elements.remove(0);
    Ok((opcode, elements))
}

/// Proxy frames between a WebSocket (frontend) and a TCP stream (guacd).
pub async fn proxy(
    ws: WebSocket,
    guacd_host: &str,
    guacd_port: u16,
    handshake: HandshakeParams,
    nvr: Option<NvrContext>,
    display_timezone: String,
) -> Result<(), AppError> {
    // Connect to guacd
    let addr = format!("{guacd_host}:{guacd_port}");
    let stream = TcpStream::connect(&addr)
        .await
        .map_err(|e| AppError::Internal(format!("guacd connect ({addr}): {e}")))?;

    handle_guac_handshake(stream, ws, handshake, nvr, display_timezone).await
}

// CodeQL note: `rust/unused-variable` misfires on the `res` binding used by
// `if let Err(e) = res` inside an `async move` block (alert #79). Suppress.
#[allow(unused_variables)]
async fn handle_guac_handshake(
    stream: TcpStream,
    ws: WebSocket,
    handshake: HandshakeParams,
    nvr: Option<NvrContext>,
    display_timezone: String,
) -> Result<(), AppError> {
    let (mut tcp_read, mut tcp_write) = tokio::io::split(stream);

    // Step 1: Send "select" instruction
    //
    // NOTE (rustguac parity, Phase 2/3): the `web` and `vdi` protocols
    // expose themselves to guacd as `vnc` and `rdp` respectively. The
    // translation will happen in the route handler that builds
    // `HandshakeParams` (see services/web_session.rs and services/vdi.rs).
    // By the time we reach this point, `handshake.protocol` is already the
    // wire-level protocol and is forwarded verbatim.
    let select = guac_instruction("select", &[&handshake.protocol]);
    tcp_write
        .write_all(&select)
        .await
        .map_err(|e| AppError::Internal(format!("guacd select write: {e}")))?;

    // Step 2: Read "args" response from guacd
    let (opcode, arg_names) = read_instruction(&mut tcp_read).await?;
    if opcode != "args" {
        return Err(AppError::Internal(format!(
            "expected 'args' from guacd, got '{opcode}'"
        )));
    }

    tracing::debug!("guacd args: {:?}", arg_names);

    // Build the resolved param map up front so the video handshake can mirror
    // the connect-time `enable-h264` value (matches rustguac's behaviour).
    let param_map = handshake.full_param_map();

    // Step 3: Send client handshake instructions (size, audio, video, image, timezone)
    // These are required by the Guacamole protocol before the "connect" instruction.
    let w = handshake.width.to_string();
    let h = handshake.height.to_string();
    let d = handshake.dpi.to_string();
    // Only advertise H.264 to guacd when the resolved RDP params actually have
    // `enable-h264=true`. Advertising it unconditionally on servers that can't
    // deliver H.264 (no GPU, no AVC444 registry config) causes RDPGFX to
    // negotiate a codec it then can't honour, which corrupts the bitmap cache
    // and produces persistent ghost tiles across the desktop. rustguac gates
    // this the same way — see sol1/rustguac src/guacd.rs `send_handshake`.
    let h264_enabled = handshake.protocol == "rdp"
        && param_map.get("enable-h264").map(String::as_str) == Some("true");
    let video_mimetypes: &[&str] = if h264_enabled { &["video/h264"] } else { &[] };
    let client_handshake: Vec<Vec<u8>> = vec![
        guac_instruction("size", &[&w, &h, &d]),
        guac_instruction("audio", &["audio/L16", "audio/L8"]),
        guac_instruction("video", video_mimetypes),
        guac_instruction("image", &["image/png", "image/jpeg", "image/webp"]),
        guac_instruction("timezone", &[&display_timezone]),
    ];
    for inst in &client_handshake {
        tcp_write
            .write_all(inst)
            .await
            .map_err(|e| AppError::Internal(format!("guacd handshake write: {e}")))?;
    }

    // Step 4: Build "connect" with values in the order guacd expects.
    // guacd prepends the protocol version as arg_names[0] (e.g. "VERSION_1_5_0").
    // Unknown args (including the version) fall through to empty string, matching
    // the approach used by rustguac. Credentials are passed upfront.

    // Debug: log the args and what we're sending for each
    for name in &arg_names {
        let val = param_map.get(name.as_str()).cloned().unwrap_or_default();
        let display = if name == "password" && !val.is_empty() {
            "***".to_string()
        } else {
            val.clone()
        };
        let msg = format!("  arg '{}' = '{}'", name, display);
        tracing::info!(msg);
    }

    let connect_values: Vec<String> = arg_names
        .iter()
        .map(|name| param_map.get(name.as_str()).cloned().unwrap_or_default())
        .collect();
    let connect_arg_refs: Vec<&str> = connect_values.iter().map(|s| s.as_str()).collect();
    let connect = guac_instruction("connect", &connect_arg_refs);

    tcp_write
        .write_all(&connect)
        .await
        .map_err(|e| AppError::Internal(format!("guacd connect write: {e}")))?;

    // Step 5: Read guacd response (should be "ready")
    let (resp_opcode, resp_args) = read_instruction(&mut tcp_read).await?;
    if resp_opcode == "error" {
        let msg = resp_args.first().cloned().unwrap_or_default();
        let code = resp_args.get(1).cloned().unwrap_or_default();
        return Err(AppError::Internal(format!(
            "guacd error: {msg} (code {code})"
        )));
    }
    if resp_opcode != "ready" {
        tracing::warn!("unexpected guacd response: {resp_opcode} {:?}", resp_args);
    }

    let connection_id = resp_args.first().cloned().unwrap_or_default();
    tracing::info!("guacd handshake complete, connection={connection_id} – proxying");

    // Note: the "ready" instruction is consumed server-side (like in the
    // standard Java Guacamole server) and is NOT forwarded to the browser
    // client. guacamole-common-js enters CONNECTED state when the WebSocket
    // opens, not when it receives "ready".

    // ── NVR: register session in the in-memory registry ──
    let mut nvr_handles = if let Some(ref ctx) = nvr {
        match ctx
            .registry
            .register(
                ctx.session_id.clone(),
                ctx.connection_id,
                ctx.connection_name.clone(),
                ctx.protocol.clone(),
                ctx.user_id,
                ctx.username.clone(),
                handshake.hostname.clone(),
                ctx.client_ip.clone(),
            )
            .await
        {
            Some((tx, buffer, kill_rx, input_rx)) => Some((
                tx,
                buffer,
                ctx.registry.clone(),
                Some(kill_rx),
                Some(input_rx),
            )),
            None => {
                tracing::error!("Session limit reached — rejecting tunnel");
                return Err(AppError::Internal(
                    "Maximum concurrent session limit reached".into(),
                ));
            }
        }
    } else {
        None
    };

    // Shared control input receiver — if present, external viewers can
    // inject mouse/keyboard instructions into this tunnel's guacd stream.
    let mut shared_input_rx: Option<tokio::sync::mpsc::Receiver<String>> = None;

    // Step 6: Bidirectional proxy loop
    //
    // Decoupled architecture:
    //   - A dedicated **writer task** drains a bounded mpsc channel into the
    //     WebSocket sink. All `ws_tx.send(Message)` callers push into this
    //     channel — which is a fast in-memory append when not full.
    //   - The **main select! loop** handles:
    //       * ws_stream.next()     — incoming browser frames → tcp_write
    //       * ping_interval        — periodic keepalive via ws_tx
    //       * kill_rx              — admin termination
    //       * shared_input_rx      — viewer-injected control input
    //       * tcp_read.read()      — guacd → ws_tx (text assembly + NVR)
    //
    // Before this refactor the loop held a single `ws: WebSocket` and called
    // `ws.send(...).await` inline inside the tcp_read arm. Under heavy guacd
    // load (e.g. Win+Arrow window-snap bitmap burst) the browser's WS receive
    // buffer would fill, `ws.send().await` would block, and during that block
    // the `ws.recv()` arm could not run — which meant mouse/keyboard events
    // from the browser piled up in the kernel TCP buffer and only flushed
    // once the backpressure relieved. Users perceived this as input "lag"
    // and mouse "acceleration" (burst of queued movements arriving at once).
    //
    // Moving the sink behind a bounded channel + dedicated writer task lets
    // the input path keep draining independently of the output path. The
    // channel capacity (1024 messages) provides a generous runway; only a
    // very slow browser can back it up, in which case `ws_tx.send().await`
    // will briefly block — but the main loop's other branches (ws_stream,
    // shared_input) continue to be polled concurrently because the channel
    // send future yields.
    const WS_OUTBOUND_CAPACITY: usize = 1024;
    let (mut ws_sink, mut ws_stream) = ws.split();
    let (ws_tx, mut ws_rx) = tokio::sync::mpsc::channel::<Message>(WS_OUTBOUND_CAPACITY);

    // Writer task: owns the sink for its lifetime.
    let mut writer_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
        // Graceful close on channel drop.
        let _ = ws_sink.close().await;
    });

    // guacamole-common-js expects each WebSocket message to contain one or
    // more *complete* Guacamole instructions (terminated by ';').  TCP reads
    // can split an instruction across chunks, so we buffer and only forward
    // up to the last ';' in each read, keeping the remainder for next time.
    let mut tcp_buf = vec![0u8; 65536];
    let mut pending = Vec::<u8>::new();
    /// Maximum pending buffer size (16 MiB). If a client sends data without
    /// instruction terminators the buffer is capped to prevent OOM.
    const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;

    // WebSocket keepalive – send a Ping every 15 s, timeout if no Pong in 30 s.
    let mut ping_interval = tokio::time::interval(Duration::from_secs(15));
    ping_interval.tick().await; // consume the first immediate tick
    let mut last_pong = tokio::time::Instant::now();

    let (bandwidth, mut kill_rx) =
        if let Some((_, _, ref registry, ref mut rx_opt, ref mut input_opt)) = nvr_handles {
            if let Some(ref ctx) = nvr {
                shared_input_rx = input_opt.take();
                (registry.get(&ctx.session_id).await, rx_opt.take())
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

    loop {
        tokio::select! {
             // Administrative kill signal
            _ = async {
                match kill_rx {
                    Some(ref mut rx) => rx.await.ok(),
                    None => {
                        std::future::pending::<()>().await;
                        Some(())
                    },
                }
            } => {
                tracing::info!("Session terminated by administrator");
                // Notify the client before closing
                let msg = "Session terminated by administrator";
                let inst = guac_instruction("error", &[msg, "521"]);
                let text = String::from_utf8_lossy(&inst).into_owned();
                let _ = ws_tx.send(Message::Text(text.into())).await;
                break;
            }

            // Writer task exit (browser disconnected or sink errored)
            _ = &mut writer_task => {
                tracing::info!("WebSocket writer task exited");
                break;
            }

            // TCP (guacd) → mpsc channel → WebSocket (frontend)
            result = tcp_read.read(&mut tcp_buf) => {
                match result {
                    Ok(0) => {
                        tracing::info!("guacd closed TCP connection");
                        // Forward an explicit "disconnect" instruction so the
                        // browser client knows the session ended server-side
                        // (as opposed to a network drop).
                        let disc = guac_instruction("disconnect", &[]);
                        let text = String::from_utf8_lossy(&disc).into_owned();
                        let _ = ws_tx.send(Message::Text(text.into())).await;
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&tcp_buf[..n]);

                        // Cap pending buffer: if guacd floods us with an instruction that
                        // never terminates, we cannot safely `clear()` and continue — the
                        // stream would resume mid-token and every subsequent parse would
                        // be corrupt. Surface an explicit Guac `error` to the client and
                        // close the tunnel so the browser side knows what happened.
                        if pending.len() > MAX_PENDING_BYTES {
                            tracing::warn!(
                                "Pending buffer exceeded {}B — closing tunnel",
                                MAX_PENDING_BYTES
                            );
                            let msg = "Protocol error: instruction exceeds pending buffer";
                            let inst = guac_instruction("error", &[msg, "521"]);
                            let text = String::from_utf8_lossy(&inst).into_owned();
                            let _ = ws_tx.send(Message::Text(text.into())).await;
                            break;
                        }

                        // Track bytes from guacd
                        if let Some(ref sess) = bandwidth {
                            sess.bytes_from_guacd
                                .fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                        }

                        // Find the last instruction boundary (';')
                        if let Some(last_semi) = pending.iter().rposition(|&b| b == b';') {
                            let complete = &pending[..=last_semi];
                            let text = String::from_utf8_lossy(complete).into_owned();
                            // `drain(..=last_semi)` is O(remainder) but avoids the full
                            // Vec reallocation that `pending = remainder.to_vec()` used to
                            // do on every burst — meaningful on Win+Arrow bitmap floods.
                            pending.drain(..=last_semi);

                            // NVR: capture frame into ring buffer + broadcast
                            if let Some((ref tx, ref buffer, _, _, _)) = nvr_handles {
                                {
                                    let mut buf: tokio::sync::RwLockWriteGuard<'_, SessionBuffer> = buffer.write().await;
                                    buf.push(text.clone());
                                }
                                let _ = tx.send(std::sync::Arc::new(text.clone()));
                            }

                            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                                tracing::info!("WebSocket send channel closed (writer task exited)");
                                break;
                            }
                        }
                        // else: no complete instruction yet, keep buffering
                    }
                    Err(e) => {
                        tracing::error!("guacd TCP read error: {e}");
                        // Tell the browser so it doesn't auto-reconnect
                        let disc = guac_instruction("disconnect", &[]);
                        let text = String::from_utf8_lossy(&disc).into_owned();
                        let _ = ws_tx.send(Message::Text(text.into())).await;
                        break;
                    }
                }
            }
            // WebSocket (frontend) → TCP (guacd)
            //
            // This branch is the input path (mouse/keyboard/resize) and is
            // the single most latency-sensitive flow in the session. Keeping
            // the output path off of the select!'s critical section (via the
            // writer task + channel) is what makes this responsive even when
            // guacd is flooding draw instructions.
            next = ws_stream.next() => {
                match next {
                    Some(Ok(Message::Text(text))) => {
                        // Validate UTF-8 and ensure it only contains valid Guacamole protocol chars
                        if !text.is_ascii() && std::str::from_utf8(text.as_bytes()).is_err() {
                            tracing::warn!("Received non-UTF8 WebSocket text — dropping");
                            continue;
                        }
                        // Track bytes to guacd
                        if let Some(ref sess) = bandwidth {
                            sess.bytes_to_guacd
                                .fetch_add(text.len() as u64, std::sync::atomic::Ordering::Relaxed);
                        }
                        if tcp_write.write_all(text.as_bytes()).await.is_err()
                            || tcp_write.flush().await.is_err()
                        {
                            tracing::info!("guacd TCP write failed");
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(_data))) => {
                        // Guacamole protocol is text-only — reject binary frames
                        tracing::warn!("Received binary WebSocket message — ignoring");
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_pong = tokio::time::Instant::now();
                    }
                    Some(Ok(Message::Close(reason))) => {
                        tracing::info!("WebSocket closed by client: {:?}", reason);
                        break;
                    }
                    Some(Err(e)) => {
                        tracing::error!("WebSocket recv error: {e}");
                        break;
                    }
                    None => {
                        tracing::info!("WebSocket stream ended");
                        break;
                    }
                    _ => {}
                }
            }
            // Shared control input — forward mouse/keyboard from external viewers
            Some(input) = async {
                match shared_input_rx {
                    Some(ref mut rx) => rx.recv().await,
                    None => {
                        std::future::pending::<Option<String>>().await
                    },
                }
            } => {
                if tcp_write.write_all(input.as_bytes()).await.is_err()
                    || tcp_write.flush().await.is_err()
                {
                    tracing::info!("guacd TCP write failed (shared input)");
                    break;
                }
            }
            // Periodic keepalive ping
            _ = ping_interval.tick() => {
                if last_pong.elapsed() > Duration::from_secs(30) {
                    tracing::info!("WebSocket keepalive timeout (no pong in 30s)");
                    break;
                }
                if ws_tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                    tracing::info!("WebSocket ping send channel closed");
                    break;
                }
                // Reset the pong deadline so we measure from ping-sent, not
                // from the last received pong. This prevents premature
                // disconnects on slow systems where the first tick fires late.
                last_pong = tokio::time::Instant::now();
            }
        }
    }

    // Drop the sender so the writer task's rx.recv() returns None and it can
    // flush + close the sink cleanly. Abort as a belt-and-braces fallback if
    // the task hasn't exited within a short grace window.
    drop(ws_tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), &mut writer_task).await;
    writer_task.abort();

    // ── NVR: unregister session ──
    if let Some(ref ctx) = nvr {
        // Capture bandwidth before unregistering (the ActiveSession will be dropped)
        let (bw_from, bw_to) = if let Some(ref sess) = bandwidth {
            (
                sess.bytes_from_guacd
                    .load(std::sync::atomic::Ordering::Relaxed) as i64,
                sess.bytes_to_guacd
                    .load(std::sync::atomic::Ordering::Relaxed) as i64,
            )
        } else {
            (0i64, 0i64)
        };

        ctx.registry.unregister(&ctx.session_id).await;
        tracing::info!("NVR session {} unregistered", ctx.session_id);

        // Clean up any quick-share files associated with this session
        let cleaned = ctx.file_store.cleanup_session(&ctx.session_id).await;
        if cleaned > 0 {
            tracing::info!(
                "Cleaned up {} quick-share file(s) for session {}",
                cleaned,
                ctx.session_id
            );
        }

        // Update recording duration + bandwidth
        let duration = (chrono::Utc::now() - ctx.started_at).num_seconds() as i32;
        let sid = ctx.session_id.clone();
        let pool = ctx.db_pool.clone();

        tokio::spawn(async move {
            let res = sqlx::query(
                "UPDATE recordings SET duration_secs = $1, bytes_from_guacd = $2, bytes_to_guacd = $3 WHERE session_id = $4"
            )
                .bind(duration)
                .bind(bw_from)
                .bind(bw_to)
                .bind(sid)
                .execute(&pool)
                .await;
            if let Err(e) = res {
                tracing::error!("Failed to update recording duration: {e}");
            }
        });
    }

    tracing::info!("Tunnel closed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── guac_instruction encoding ──────────────────────────────────
    #[test]
    fn guac_instruction_select_rdp() {
        let bytes = guac_instruction("select", &["rdp"]);
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, "6.select,3.rdp;");
    }

    #[test]
    fn guac_instruction_no_args() {
        let bytes = guac_instruction("video", &[]);
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, "5.video;");
    }

    #[test]
    fn guac_instruction_multiple_args() {
        let bytes = guac_instruction("size", &["1920", "1080", "96"]);
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, "4.size,4.1920,4.1080,2.96;");
    }

    #[test]
    fn guac_instruction_empty_arg() {
        let bytes = guac_instruction("connect", &["", "host"]);
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, "7.connect,0.,4.host;");
    }

    // ── parse_instruction ──────────────────────────────────────────
    #[test]
    fn parse_instruction_simple() {
        let (op, args) = parse_instruction("4.args,8.hostname,4.port;").unwrap();
        assert_eq!(op, "args");
        assert_eq!(args, vec!["hostname", "port"]);
    }

    #[test]
    fn parse_instruction_no_args() {
        let (op, args) = parse_instruction("5.ready;").unwrap();
        assert_eq!(op, "ready");
        assert!(args.is_empty());
    }

    #[test]
    fn parse_instruction_roundtrip() {
        let encoded = guac_instruction("connect", &["host.example.com", "3389", "admin"]);
        let text = String::from_utf8(encoded).unwrap();
        let (op, args) = parse_instruction(&text).unwrap();
        assert_eq!(op, "connect");
        assert_eq!(args, vec!["host.example.com", "3389", "admin"]);
    }

    #[test]
    fn parse_instruction_empty_string_arg() {
        // An arg with length 0 produces an empty string
        let (op, args) = parse_instruction("6.select,0.;").unwrap();
        assert_eq!(op, "select");
        assert_eq!(args, vec![""]);
    }

    #[test]
    fn parse_instruction_errors_on_empty() {
        assert!(parse_instruction(";").is_err());
    }

    #[test]
    fn parse_instruction_errors_on_truncated() {
        // Length says 10 but only 3 chars follow
        assert!(parse_instruction("10.abc;").is_err());
    }

    #[test]
    fn parse_instruction_errors_on_no_dot() {
        assert!(parse_instruction("nodot;").is_err());
    }

    // ── is_allowed_guacd_param ─────────────────────────────────────
    #[test]
    fn allowed_params_whitelist() {
        assert!(is_allowed_guacd_param("color-depth"));
        assert!(is_allowed_guacd_param("enable-wallpaper"));
        assert!(is_allowed_guacd_param("resize-method"));
        assert!(is_allowed_guacd_param("font-size"));
        assert!(is_allowed_guacd_param("force-lossless"));
    }

    #[test]
    fn blocked_params_not_in_whitelist() {
        assert!(!is_allowed_guacd_param("hostname"));
        assert!(!is_allowed_guacd_param("password"));
        assert!(!is_allowed_guacd_param("username"));
        assert!(!is_allowed_guacd_param("drive-path"));
        assert!(!is_allowed_guacd_param("enable-drive"));
        assert!(!is_allowed_guacd_param("arbitrary-param"));
    }

    // ── HandshakeParams ────────────────────────────────────────────
    #[test]
    fn handshake_param_map_basic() {
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "10.0.0.1".into(),
            port: 3389,
            username: Some("admin".into()),
            password: Some("secret".into()),
            domain: Some("CORP".into()),
            security: Some("nla".into()),
            ignore_cert: true,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.param_map();
        assert_eq!(m["hostname"], "10.0.0.1");
        assert_eq!(m["port"], "3389");
        assert_eq!(m["username"], "admin");
        assert_eq!(m["password"], "secret");
        assert_eq!(m["domain"], "CORP");
        assert_eq!(m["security"], "nla");
        assert_eq!(m["ignore-cert"], "true");
        assert_eq!(m["width"], "1920");
        assert_eq!(m["height"], "1080");
        assert_eq!(m["dpi"], "96");
        assert_eq!(m["resize-method"], "display-update");
    }

    #[test]
    fn handshake_param_map_optional_fields_omitted() {
        let hp = HandshakeParams {
            protocol: "ssh".into(),
            hostname: "box".into(),
            port: 22,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 800,
            height: 600,
            dpi: 72,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.param_map();
        assert!(!m.contains_key("username"));
        assert!(!m.contains_key("password"));
        assert!(!m.contains_key("domain"));
        assert!(!m.contains_key("security"));
        assert!(!m.contains_key("ignore-cert"));
        assert!(!m.contains_key("recording-path"));
    }

    #[test]
    fn handshake_recording_path_included() {
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: Some("/tmp/rec".into()),
            recording_name: None,
            create_recording_path: true,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.param_map();
        assert_eq!(m["recording-path"], "/tmp/rec");
        assert_eq!(m["create-recording-path"], "true");
    }

    #[test]
    fn full_param_map_rdp_defaults() {
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        // RDP: drive is NOT enabled unless admin sets `enable-drive=true` explicitly.
        assert!(!m.contains_key("enable-drive"));
        assert!(!m.contains_key("drive-path"));
        // Non-drive defaults still applied. RDPGFX and H.264 are opt-in
        // (matches rustguac) — forcing them on for every RDP connection
        // produces tile-cache ghosting on hosts without H.264/AVC444 support.
        assert_eq!(m["disable-gfx"], "true");
        assert_eq!(m["enable-h264"], "false");
        assert_eq!(m["color-depth"], "32");
        // Clipboard
        assert_eq!(m["disable-copy"], "false");
        assert_eq!(m["disable-paste"], "false");
    }

    #[test]
    fn full_param_map_rdp_drive_enabled_via_extras() {
        let mut extras = std::collections::HashMap::new();
        extras.insert("enable-drive".to_string(), "true".to_string());
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: extras,
        };
        let m = hp.full_param_map();
        assert_eq!(m["enable-drive"], "true");
        assert_eq!(m["drive-path"], "/var/lib/guacamole/drive");
    }

    #[test]
    fn full_param_map_ssh_defaults() {
        let hp = HandshakeParams {
            protocol: "ssh".into(),
            hostname: "h".into(),
            port: 22,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 800,
            height: 600,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        // SSH: SFTP is NOT enabled unless admin sets `enable-sftp=true` explicitly.
        assert!(!m.contains_key("enable-sftp"));
        // Should NOT have RDP-specific params
        assert!(!m.contains_key("enable-drive"));
        assert!(!m.contains_key("disable-gfx"));
        assert!(!m.contains_key("enable-h264"));
    }

    #[test]
    fn full_param_map_ssh_sftp_enabled_via_extras() {
        let mut extras = std::collections::HashMap::new();
        extras.insert("enable-sftp".to_string(), "true".to_string());
        let hp = HandshakeParams {
            protocol: "ssh".into(),
            hostname: "h".into(),
            port: 22,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 800,
            height: 600,
            dpi: 96,
            extra: extras,
        };
        let m = hp.full_param_map();
        assert_eq!(m["enable-sftp"], "true");
    }

    #[test]
    fn full_param_map_rdp_drive_disabled_via_extras() {
        // Admin cleared the `enable-drive` checkbox → empty-string value in extras.
        // The tunnel must NOT enable the virtual drive for guacd.
        let mut extras = std::collections::HashMap::new();
        extras.insert("enable-drive".to_string(), String::new());
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: extras,
        };
        let m = hp.full_param_map();
        assert!(!m.contains_key("enable-drive"));
        assert!(!m.contains_key("drive-path"));
        assert!(!m.contains_key("drive-name"));
        assert!(!m.contains_key("create-drive-path"));
    }

    #[test]
    fn full_param_map_ssh_sftp_disabled_via_extras() {
        let mut extras = std::collections::HashMap::new();
        extras.insert("enable-sftp".to_string(), String::new());
        let hp = HandshakeParams {
            protocol: "ssh".into(),
            hostname: "h".into(),
            port: 22,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 800,
            height: 600,
            dpi: 96,
            extra: extras,
        };
        let m = hp.full_param_map();
        assert!(!m.contains_key("enable-sftp"));
    }

    #[test]
    fn full_param_map_extra_override() {
        let mut extra = std::collections::HashMap::new();
        extra.insert("color-depth".into(), "24".into());
        extra.insert("enable-wallpaper".into(), "true".into());
        // Blocked param should be ignored
        extra.insert("hostname".into(), "evil.com".into());
        // Empty value should be ignored
        extra.insert("font-size".into(), "".into());

        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "legit.com".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra,
        };
        let m = hp.full_param_map();
        assert_eq!(m["color-depth"], "24");
        assert_eq!(m["enable-wallpaper"], "true");
        // hostname should remain the original, not overridden
        assert_eq!(m["hostname"], "legit.com");
        // Empty value not inserted
        assert!(!m.contains_key("font-size"));
    }

    #[test]
    fn full_param_map_recording_not_overridable() {
        let mut extra = std::collections::HashMap::new();
        extra.insert("recording-path".into(), "/tmp/evil".into());
        extra.insert("recording-name".into(), "evil.guac".into());
        extra.insert("create-recording-path".into(), "false".into());

        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: Some("/var/lib/guacamole/recordings".into()),
            recording_name: Some("backend-generated.guac".into()),
            create_recording_path: true,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra,
        };
        let m = hp.full_param_map();
        // Recording params must not be overridden by extra
        assert_eq!(m["recording-path"], "/var/lib/guacamole/recordings");
        assert_eq!(m["recording-name"], "backend-generated.guac");
        assert_eq!(m["create-recording-path"], "true");
    }

    #[test]
    fn test_parse_instruction_utf8() {
        // "4.café,2.is,4.good;"
        // 'café' has 4 chars, 5 bytes in UTF-8
        let input = "4.café,2.is,4.good;";
        let (opcode, args) = parse_instruction(input).unwrap();
        assert_eq!(opcode, "café");
        assert_eq!(args, vec!["is", "good"]);
    }

    #[test]
    fn test_parse_instruction_multibyte() {
        // "1.Ω,5.alpha;"
        let input = "1.Ω,5.alpha;";
        let (opcode, args) = parse_instruction(input).unwrap();
        assert_eq!(opcode, "Ω");
        assert_eq!(args, vec!["alpha"]);
    }

    #[test]
    fn test_parse_instruction_normal() {
        let input = "4.args,8.hostname,4.port;";
        let (opcode, args) = parse_instruction(input).unwrap();
        assert_eq!(opcode, "args");
        assert_eq!(args, vec!["hostname", "port"]);
    }

    // ── Additional coverage: guac_instruction multibyte ─────────────
    #[test]
    fn guac_instruction_with_unicode_content() {
        let bytes = guac_instruction("key", &["café"]);
        let s = String::from_utf8(bytes).unwrap();
        // "café" is 4 chars / 5 bytes – guac uses byte-length encoding
        assert_eq!(s, "3.key,5.café;");
    }

    #[test]
    fn guac_instruction_long_opcode() {
        let bytes = guac_instruction("disconnect", &[]);
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, "10.disconnect;");
    }

    #[test]
    fn guac_instruction_many_args() {
        let bytes = guac_instruction("size", &["1920", "1080", "96", "0", "0"]);
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.starts_with("4.size,"));
        assert!(s.ends_with(";"));
        assert_eq!(s.matches(',').count(), 5);
    }

    // ── parse_instruction: more edge cases ─────────────────────────
    #[test]
    fn parse_instruction_single_char_opcode() {
        let (op, args) = parse_instruction("1.x;").unwrap();
        assert_eq!(op, "x");
        assert!(args.is_empty());
    }

    #[test]
    fn parse_instruction_large_length() {
        let long_val = "a".repeat(100);
        let input = format!("100.{long_val};");
        let (op, args) = parse_instruction(&input).unwrap();
        assert_eq!(op, long_val);
        assert!(args.is_empty());
    }

    #[test]
    fn parse_instruction_multiple_empty_args() {
        let (op, args) = parse_instruction("4.noop,0.,0.,0.;").unwrap();
        assert_eq!(op, "noop");
        assert_eq!(args, vec!["", "", ""]);
    }

    #[test]
    fn parse_instruction_error_message_contains_input() {
        let result = parse_instruction("bad;");
        match result {
            Err(AppError::Internal(msg)) => assert!(msg.contains("bad;")),
            other => panic!("expected Internal error, got {:?}", other),
        }
    }

    // ── HandshakeParams: VNC protocol ──────────────────────────────
    #[test]
    fn full_param_map_vnc_defaults() {
        let hp = HandshakeParams {
            protocol: "vnc".into(),
            hostname: "vnc-host".into(),
            port: 5900,
            username: None,
            password: Some("vncpass".into()),
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1024,
            height: 768,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        // VNC should NOT have RDP-specific or SSH-specific params
        assert!(!m.contains_key("enable-drive"));
        assert!(!m.contains_key("disable-gfx"));
        assert!(!m.contains_key("enable-h264"));
        assert!(!m.contains_key("enable-sftp"));
        // Should still have clipboard and resize-method
        assert_eq!(m["disable-copy"], "false");
        assert_eq!(m["disable-paste"], "false");
        assert_eq!(m["resize-method"], "display-update");
        assert_eq!(m["hostname"], "vnc-host");
        assert_eq!(m["port"], "5900");
        assert_eq!(m["password"], "vncpass");
    }

    #[test]
    fn full_param_map_extra_blocked_params_ignored() {
        let mut extra = std::collections::HashMap::new();
        extra.insert("password".into(), "evil".into());
        extra.insert("recording-path".into(), "/tmp/evil".into());
        extra.insert("drive-path".into(), "/tmp/evil".into());

        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: Some("real-pw".into()),
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra,
        };
        let m = hp.full_param_map();
        // password should remain the real one, not overridden
        assert_eq!(m["password"], "real-pw");
        // blocked extra params should not override defaults
        assert_ne!(m.get("drive-path").map(|s| s.as_str()), Some("/tmp/evil"));
    }

    #[test]
    fn full_param_map_ignore_cert_false_omits_key() {
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        assert!(!m.contains_key("ignore-cert"));
    }

    #[test]
    fn full_param_map_recording_path_without_create() {
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: Some("/recordings".into()),
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        assert_eq!(m["recording-path"], "/recordings");
        assert!(!m.contains_key("create-recording-path"));
    }

    // ── is_allowed_guacd_param: more specifics ─────────────────────
    #[test]
    fn allowed_params_full_whitelist() {
        let allowed = [
            "enable-theming",
            "enable-font-smoothing",
            "enable-full-window-drag",
            "enable-desktop-composition",
            "enable-menu-animations",
            "enable-printing",
            "server-layout",
            "console",
            "initial-program",
            "timezone",
            "client-name",
            "enable-audio",
            "enable-audio-input",
            "disable-audio",
            "enable-touch",
            "swap-red-blue",
            "cursor",
            "read-only",
            "scrollback",
            "font-name",
            "backspace",
            "terminal-type",
            "typescript-path",
            "typescript-name",
            "create-typescript-path",
            "wol-send-packet",
            "wol-mac-addr",
            "wol-broadcast-addr",
            "wol-udp-port",
            "wol-wait-time",
            "disable-glyph-caching",
        ];
        for param in &allowed {
            assert!(is_allowed_guacd_param(param), "expected allowed: {param}");
        }
    }

    // ── read_instruction from a stream ─────────────────────────────
    #[tokio::test]
    async fn read_instruction_from_cursor() {
        let data = b"4.args,8.hostname,4.port;";
        let mut cursor = std::io::Cursor::new(data);
        let (op, args) = read_instruction(&mut cursor).await.unwrap();
        assert_eq!(op, "args");
        assert_eq!(args, vec!["hostname", "port"]);
    }

    #[tokio::test]
    async fn read_instruction_eof_returns_error() {
        let data = b""; // empty — EOF immediately
        let mut cursor = std::io::Cursor::new(data);
        let result = read_instruction(&mut cursor).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn read_instruction_ready() {
        let data = b"5.ready,36.abc12345-1234-1234-1234-123456789012;";
        let mut cursor = std::io::Cursor::new(data);
        let (op, args) = read_instruction(&mut cursor).await.unwrap();
        assert_eq!(op, "ready");
        assert_eq!(args.len(), 1);
    }

    // ── read_instruction edge cases ────────────────────────────────

    #[tokio::test]
    async fn read_instruction_error_instruction() {
        let data = b"5.error,20.Server not available,3.519;";
        let mut cursor = std::io::Cursor::new(data);
        let (op, args) = read_instruction(&mut cursor).await.unwrap();
        assert_eq!(op, "error");
        assert_eq!(args[0], "Server not available");
        assert_eq!(args[1], "519");
    }

    #[tokio::test]
    async fn read_instruction_nop() {
        let data = b"3.nop;";
        let mut cursor = std::io::Cursor::new(data);
        let (op, args) = read_instruction(&mut cursor).await.unwrap();
        assert_eq!(op, "nop");
        assert!(args.is_empty());
    }

    #[tokio::test]
    async fn read_instruction_select() {
        let data = b"6.select,3.rdp;";
        let mut cursor = std::io::Cursor::new(data);
        let (op, args) = read_instruction(&mut cursor).await.unwrap();
        assert_eq!(op, "select");
        assert_eq!(args, vec!["rdp"]);
    }

    // ── HandshakeParams edge cases ─────────────────────────────────

    #[test]
    fn param_map_with_recording_name() {
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: Some("/recordings".into()),
            recording_name: Some("session.guac".into()),
            create_recording_path: true,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.param_map();
        assert_eq!(m["recording-path"], "/recordings");
        assert_eq!(m["recording-name"], "session.guac");
        assert_eq!(m["create-recording-path"], "true");
    }

    #[test]
    fn full_param_map_clipboard_for_all_protocols() {
        for proto in &["rdp", "ssh", "vnc", "telnet"] {
            let hp = HandshakeParams {
                protocol: proto.to_string(),
                hostname: "h".into(),
                port: 22,
                username: None,
                password: None,
                domain: None,
                security: None,
                ignore_cert: false,
                recording_path: None,
                recording_name: None,
                create_recording_path: false,
                width: 800,
                height: 600,
                dpi: 96,
                extra: std::collections::HashMap::new(),
            };
            let m = hp.full_param_map();
            assert_eq!(
                m["disable-copy"], "false",
                "disable-copy missing for {proto}"
            );
            assert_eq!(
                m["disable-paste"], "false",
                "disable-paste missing for {proto}"
            );
        }
    }

    #[test]
    fn full_param_map_rdp_clipboard_buffer() {
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        assert_eq!(m["clipboard-buffer-size"], "8388608"); // 8 MiB
    }

    #[test]
    fn full_param_map_clipboard_disable_override() {
        let mut extra = std::collections::HashMap::new();
        extra.insert("disable-copy".into(), "true".into());
        extra.insert("disable-paste".into(), "true".into());
        let hp = HandshakeParams {
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            username: None,
            password: None,
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra,
        };
        let m = hp.full_param_map();
        assert_eq!(m["disable-copy"], "true", "extra should override default");
        assert_eq!(m["disable-paste"], "true", "extra should override default");
    }

    // ── guac_instruction edge cases ────────────────────────────────

    #[test]
    fn guac_instruction_with_empty_string_arg() {
        let bytes = guac_instruction("test", &[""]);
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, "4.test,0.;");
    }

    #[test]
    fn guac_instruction_error_format() {
        let bytes = guac_instruction("error", &["Not found", "404"]);
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, "5.error,9.Not found,3.404;");
    }

    // ── is_allowed_guacd_param: additional blocked names ───────────

    #[test]
    fn blocked_sensitive_params() {
        // These should never be allowed via extra
        assert!(!is_allowed_guacd_param("domain"));
        assert!(!is_allowed_guacd_param("security"));
        assert!(!is_allowed_guacd_param("port"));
        assert!(!is_allowed_guacd_param("recording-path"));
        assert!(!is_allowed_guacd_param("recording-name"));
        assert!(!is_allowed_guacd_param("create-recording-path"));
    }

    // ── json_to_string_map ─────────────────────────────────────────

    #[test]
    fn json_to_string_map_object_strings() {
        let val = serde_json::json!({"color-depth": "24", "enable-wallpaper": "true"});
        let m = json_to_string_map(&val);
        assert_eq!(m["color-depth"], "24");
        assert_eq!(m["enable-wallpaper"], "true");
    }

    #[test]
    fn json_to_string_map_mixed_types() {
        let val = serde_json::json!({"str": "hello", "bool": true, "num": 42, "arr": [1,2]});
        let m = json_to_string_map(&val);
        assert_eq!(m["str"], "hello");
        assert_eq!(m["bool"], "true");
        assert_eq!(m["num"], "42");
        assert!(!m.contains_key("arr"), "arrays should be skipped");
    }

    #[test]
    fn json_to_string_map_empty_object() {
        let val = serde_json::json!({});
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_non_object() {
        let val = serde_json::json!("just a string");
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_null() {
        let val = serde_json::Value::Null;
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_array() {
        let val = serde_json::json!([1, 2, 3]);
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_nested_object_skipped() {
        let val = serde_json::json!({"key": "val", "nested": {"a": "b"}});
        let m = json_to_string_map(&val);
        assert_eq!(m.len(), 1);
        assert_eq!(m["key"], "val");
    }

    #[test]
    fn json_to_string_map_bool_false() {
        let val = serde_json::json!({"flag": false});
        let m = json_to_string_map(&val);
        assert_eq!(m["flag"], "false");
    }

    #[test]
    fn json_to_string_map_number_float() {
        let val = serde_json::json!({"dpi": 96.5});
        let m = json_to_string_map(&val);
        assert_eq!(m["dpi"], "96.5");
    }

    #[test]
    fn json_to_string_map_number_negative() {
        let val = serde_json::json!({"offset": -10});
        let m = json_to_string_map(&val);
        assert_eq!(m["offset"], "-10");
    }

    #[test]
    fn json_to_string_map_empty_string_value() {
        let val = serde_json::json!({"empty": ""});
        let m = json_to_string_map(&val);
        assert_eq!(m["empty"], "");
    }

    #[test]
    fn json_to_string_map_null_value_skipped() {
        let val = serde_json::json!({"present": "yes", "absent": null});
        let m = json_to_string_map(&val);
        assert_eq!(m.len(), 1);
        assert_eq!(m["present"], "yes");
    }
}
