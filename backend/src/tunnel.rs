use axum::extract::ws::{Message, WebSocket};
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
            m.entry("enable-drive".into()).or_insert_with(|| "true".into());
            m.entry("drive-path".into()).or_insert_with(|| "/var/lib/guacamole/drive".into());
            m.entry("drive-name".into()).or_insert_with(|| "Guacamole".into());
            m.entry("create-drive-path".into()).or_insert_with(|| "true".into());

            // FreeRDP 3 GFX pipeline — enables H.264 hardware/software encoding
            // for significantly lower bandwidth usage on modern RDP hosts.
            m.entry("enable-gfx".into()).or_insert_with(|| "true".into());
            m.entry("enable-gfx-h264".into()).or_insert_with(|| "true".into());
        }

        // SFTP for SSH connections
        if self.protocol == "ssh" {
            m.entry("enable-sftp".into()).or_insert_with(|| "true".into());
        }

        // Clipboard — enable for all protocols
        m.entry("disable-copy".into()).or_insert_with(|| "false".into());
        m.entry("disable-paste".into()).or_insert_with(|| "false".into());

        // Merge extra params — they override base values
        for (k, v) in &self.extra {
            if !v.is_empty() {
                m.insert(k.clone(), v.clone());
            }
        }
        m
    }
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
async fn read_instruction(reader: &mut (impl AsyncReadExt + Unpin)) -> Result<(String, Vec<String>), AppError> {
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        let n = reader
            .read(&mut byte)
            .await
            .map_err(|e| AppError::Internal(format!("guacd read: {e}")))?;
        if n == 0 {
            return Err(AppError::Internal("guacd closed connection during handshake".into()));
        }
        buf.push(byte[0]);
        if byte[0] == b';' {
            break;
        }
    }

    let text = String::from_utf8(buf)
        .map_err(|e| AppError::Internal(format!("guacd non-utf8: {e}")))?;

    parse_instruction(&text)
}

/// Parse a Guacamole instruction string like "4.args,8.hostname,4.port;"
fn parse_instruction(raw: &str) -> Result<(String, Vec<String>), AppError> {
    let trimmed = raw.trim_end_matches(';');
    let mut elements = Vec::new();
    let mut remaining = trimmed;

    while !remaining.is_empty() {
        // Find the dot separating length from value
        let dot_pos = remaining.find('.')
            .ok_or_else(|| AppError::Internal(format!("bad guac instruction: {raw}")))?;
        let len: usize = remaining[..dot_pos].parse()
            .map_err(|_| AppError::Internal(format!("bad guac length: {raw}")))?;
        let value_start = dot_pos + 1;
        let value_end = value_start + len;
        if value_end > remaining.len() {
            return Err(AppError::Internal(format!("guac instruction truncated: {raw}")));
        }
        elements.push(remaining[value_start..value_end].to_string());
        remaining = &remaining[value_end..];
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
        return Err(AppError::Internal(format!("expected 'args' from guacd, got '{opcode}'")));
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
        tracing::debug!(msg);
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
        return Err(AppError::Internal(format!("guacd error: {msg} (code {code})")));
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
    let nvr_handles = if let Some(ref ctx) = nvr {
        let (tx, buffer) = ctx.registry.register(
            ctx.session_id.clone(),
            ctx.connection_id,
            ctx.connection_name.clone(),
            ctx.protocol.clone(),
            ctx.user_id,
            ctx.username.clone(),
        ).await;
        Some((tx, buffer, ctx.registry.clone()))
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

    // Resolve bandwidth counters (if NVR is active, track via session handle)
    let bandwidth = if let Some((_, _, ref registry)) = nvr_handles {
        if let Some(ref ctx) = nvr {
            registry.get(&ctx.session_id).await
        } else {
            None
        }
    } else {
        None
    };

    loop {
        tokio::select! {
            // TCP (guacd) → WebSocket (frontend)
            result = tcp_read.read(&mut tcp_buf) => {
                match result {
                    Ok(0) => {
                        tracing::info!("guacd closed TCP connection");
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&tcp_buf[..n]);

                        // Track bytes from guacd
                        if let Some(ref sess) = bandwidth {
                            sess.bytes_from_guacd.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                        }

                        // Find the last instruction boundary (';')
                        if let Some(last_semi) = pending.iter().rposition(|&b| b == b';') {
                            let complete = &pending[..=last_semi];
                            let text = String::from_utf8_lossy(complete).into_owned();
                            let remainder = pending[last_semi + 1..].to_vec();
                            pending = remainder;

                            // NVR: capture frame into ring buffer + broadcast
                            if let Some((ref tx, ref buffer, _)) = nvr_handles {
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
                        // Track bytes to guacd
                        if let Some(ref sess) = bandwidth {
                            sess.bytes_to_guacd.fetch_add(text.len() as u64, std::sync::atomic::Ordering::Relaxed);
                        }
                        if tcp_write.write_all(text.as_bytes()).await.is_err()
                            || tcp_write.flush().await.is_err()
                        {
                            tracing::info!("guacd TCP write failed");
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        // Track bytes to guacd
                        if let Some(ref sess) = bandwidth {
                            sess.bytes_to_guacd.fetch_add(data.len() as u64, std::sync::atomic::Ordering::Relaxed);
                        }
                        if tcp_write.write_all(&data).await.is_err()
                            || tcp_write.flush().await.is_err()
                        {
                            tracing::info!("guacd TCP write failed (binary)");
                            break;
                        }
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
