use axum::extract::ws::{Message, WebSocket};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::AppError;
use crate::services::session_registry::SessionRegistry;

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

        // RDP virtual drive — enables file transfer via RDPDR channel
        if self.protocol == "rdp" {
            m.entry("enable-drive".into())
                .or_insert_with(|| "true".into());
            m.entry("drive-path".into())
                .or_insert_with(|| "/var/lib/guacamole/drive".into());
            m.entry("drive-name".into())
                .or_insert_with(|| "Guacamole".into());
            m.entry("create-drive-path".into())
                .or_insert_with(|| "true".into());

            // FreeRDP 3 GFX pipeline — enables H.264 hardware/software encoding
            // for significantly lower bandwidth usage on modern RDP hosts.
            m.entry("enable-gfx".into())
                .or_insert_with(|| "true".into());
            m.entry("enable-gfx-h264".into())
                .or_insert_with(|| "true".into());

            // Increase clipboard buffer size to 8 MiB (default is often 64KB - 256KB)
            m.entry("clipboard-buffer-size".into())
                .or_insert_with(|| "8388608".into());
        }

        // SFTP for SSH connections
        if self.protocol == "ssh" {
            m.entry("enable-sftp".into())
                .or_insert_with(|| "true".into());
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
/// Sensitive parameters (credentials, recording paths, drive paths) are excluded.
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
            | "enable-gfx-h264"
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
            | "ignore-cert"
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
    mut ws: WebSocket,
    guacd_host: &str,
    guacd_port: u16,
    handshake: HandshakeParams,
    nvr: Option<NvrContext>,
) -> Result<(), AppError> {
    // Connect to guacd
    let addr = format!("{guacd_host}:{guacd_port}");
    let stream = TcpStream::connect(&addr)
        .await
        .map_err(|e| AppError::Internal(format!("guacd connect ({addr}): {e}")))?;

    let (mut tcp_read, mut tcp_write) = tokio::io::split(stream);

    // Step 1: Send "select" instruction
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

    // Step 3: Send client handshake instructions (size, audio, video, image, timezone)
    // These are required by the Guacamole protocol before the "connect" instruction.
    let w = handshake.width.to_string();
    let h = handshake.height.to_string();
    let d = handshake.dpi.to_string();
    let client_handshake: Vec<Vec<u8>> = vec![
        guac_instruction("size", &[&w, &h, &d]),
        guac_instruction("audio", &["audio/L16", "audio/L8"]),
        guac_instruction("video", &[]),
        guac_instruction("image", &["image/png", "image/jpeg", "image/webp"]),
        guac_instruction("timezone", &["UTC"]),
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
    let param_map = handshake.full_param_map();

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
            Some((tx, buffer, kill_rx)) => Some((tx, buffer, ctx.registry.clone(), Some(kill_rx))),
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

    // Step 6: Bidirectional proxy loop
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

    let (bandwidth, mut kill_rx) = if let Some((_, _, ref registry, ref mut rx_opt)) = nvr_handles {
        if let Some(ref ctx) = nvr {
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
                let _ = ws.send(axum::extract::ws::Message::Text(text)).await;
                break;
            }

            // TCP (guacd) → WebSocket (frontend)
            result = tcp_read.read(&mut tcp_buf) => {
                match result {
                    Ok(0) => {
                        tracing::info!("guacd closed TCP connection");
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&tcp_buf[..n]);

                        // Cap pending buffer to prevent OOM from malformed streams
                        if pending.len() > MAX_PENDING_BYTES {
                            tracing::warn!(
                                "Pending buffer exceeded {}B — dropping data",
                                MAX_PENDING_BYTES
                            );
                            pending.clear();
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
                            let remainder = pending[last_semi + 1..].to_vec();
                            pending = remainder;

                            // NVR: capture frame into ring buffer + broadcast
                            if let Some((ref tx, ref buffer, _, _)) = nvr_handles {
                                {
                                    let mut buf = buffer.write().await;
                                    buf.push(text.clone());
                                }
                                let _ = tx.send(std::sync::Arc::new(text.clone()));
                            }

                            if ws.send(Message::Text(text)).await.is_err() {
                                tracing::info!("WebSocket send failed (client disconnected)");
                                break;
                            }
                        }
                        // else: no complete instruction yet, keep buffering
                    }
                    Err(e) => {
                        tracing::error!("guacd TCP read error: {e}");
                        break;
                    }
                }
            }
            // WebSocket (frontend) → TCP (guacd)
            result = ws.recv() => {
                match result {
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
            // Periodic keepalive ping
            _ = ping_interval.tick() => {
                if last_pong.elapsed() > Duration::from_secs(30) {
                    tracing::info!("WebSocket keepalive timeout (no pong in 30s)");
                    break;
                }
                if ws.send(Message::Ping(Vec::new())).await.is_err() {
                    tracing::info!("WebSocket ping send failed");
                    break;
                }
                // Reset the pong deadline so we measure from ping-sent, not
                // from the last received pong. This prevents premature
                // disconnects on slow systems where the first tick fires late.
                last_pong = tokio::time::Instant::now();
            }
        }
    }

    // ── NVR: unregister session ──
    if let Some(ref ctx) = nvr {
        ctx.registry.unregister(&ctx.session_id).await;
        tracing::info!("NVR session {} unregistered", ctx.session_id);
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
        assert!(!is_allowed_guacd_param("recording-path"));
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
            create_recording_path: false,
            width: 1920,
            height: 1080,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        // RDP-specific defaults
        assert_eq!(m["enable-drive"], "true");
        assert_eq!(m["drive-path"], "/var/lib/guacamole/drive");
        assert_eq!(m["enable-gfx"], "true");
        assert_eq!(m["enable-gfx-h264"], "true");
        // Clipboard
        assert_eq!(m["disable-copy"], "false");
        assert_eq!(m["disable-paste"], "false");
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
            create_recording_path: false,
            width: 800,
            height: 600,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        assert_eq!(m["enable-sftp"], "true");
        // Should NOT have RDP-specific params
        assert!(!m.contains_key("enable-drive"));
        assert!(!m.contains_key("enable-gfx"));
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
            create_recording_path: false,
            width: 1024,
            height: 768,
            dpi: 96,
            extra: std::collections::HashMap::new(),
        };
        let m = hp.full_param_map();
        // VNC should NOT have RDP-specific or SSH-specific params
        assert!(!m.contains_key("enable-drive"));
        assert!(!m.contains_key("enable-gfx"));
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
}
