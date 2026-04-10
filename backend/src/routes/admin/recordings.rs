// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use futures_util::{StreamExt, SinkExt};

use crate::db::Recording;
use crate::error::AppError;
use crate::services::app_state::{SharedState, BootPhase};


#[derive(Deserialize)]
pub struct ListRecordingsQuery {
    pub user_id: Option<uuid::Uuid>,
    pub connection_id: Option<uuid::Uuid>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// List historical recordings with optional filters
pub async fn list_recordings(
    State(state): State<SharedState>,
    Query(query): Query<ListRecordingsQuery>,
) -> Result<Json<Vec<Recording>>, AppError> {
    let db = {
        let s = state.read().await;
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    let recordings = sqlx::query_as::<_, Recording>(
        "SELECT * FROM recordings 
         WHERE ($1::uuid IS NULL OR user_id = $1)
           AND ($2::uuid IS NULL OR connection_id = $2)
         ORDER BY started_at DESC
         LIMIT $3 OFFSET $4"
    )
    .bind(query.user_id)
    .bind(query.connection_id)
    .bind(query.limit.unwrap_or(50))
    .bind(query.offset.unwrap_or(0))
    .fetch_all(&db.pool)
    .await?;

    Ok(Json(recordings))
}

/// Stream a historical recording via WebSocket with pacing
pub async fn stream_recording(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, AppError> {
    tracing::info!("Received stream_recording request for ID: {}", id);

    let db = {
        let s = state.read().await;
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    // Fetch recording metadata
    let recording: Recording = sqlx::query_as("SELECT * FROM recordings WHERE id = $1")
        .bind(id)
        .fetch_optional(&db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Recording not found".into()))?;

    // Configure WebSocket with much higher limits for large recording blobs
    Ok(ws
        .max_frame_size(16 * 1024 * 1024)
        .max_message_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| async move {
        if let Err(e) = handle_recording_stream(socket, state, recording).await {
            tracing::error!("Recording stream error: {e}");
        }
    }))
}

async fn handle_recording_stream(
    mut socket: axum::extract::ws::WebSocket,
    state: SharedState,
    recording: Recording,
) -> anyhow::Result<()> {
    let mut reader = if recording.storage_type == "local" {
        let path = format!("/var/lib/guacamole/recordings/{}", recording.storage_path);
        let file = tokio::fs::File::open(path).await?;
        Box::new(tokio::io::BufReader::new(file)) as Box<dyn tokio::io::AsyncRead + Unpin + Send>
    } else {
        let azure = {
            let s = state.read().await;
            let pool = s.db.as_ref().ok_or_else(|| anyhow::anyhow!("DB not connected"))?.pool.clone();
            let vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).cloned();
            crate::services::recordings::get_azure_config(&pool, vault.as_ref()).await?
        };
        if let Some(azure) = azure {
            let stream = crate::services::recordings::download_stream_from_azure(&azure, &recording.storage_path).await?;
            let reader = tokio_util::io::StreamReader::new(
                stream.map(|res: reqwest::Result<bytes::Bytes>| {
                    res.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
                })
            );
            Box::new(tokio::io::BufReader::new(reader)) as Box<dyn tokio::io::AsyncRead + Unpin + Send>
        } else {
            anyhow::bail!("Azure storage not configured");
        }
    };

    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Background task: Sink (read and discard messages from client)
    // This prevents the TCP window from filling up if the client sends data (like handshakes)
    tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            if let Err(e) = msg {
                tracing::debug!("WebSocket receiver closed: {e}");
                break;
            }
        }
    });

    let mut parser = GuacamoleParser::new();
    let mut base_guac_ts: Option<u64> = None;
    let mut base_real_ts: Option<std::time::Instant> = None;
    let mut last_progress_sent = std::time::Instant::now();

    let mut buf = [0u8; 16384];
    let mut send_buffer = String::with_capacity(32768);

    // Initial wake-up (nop)
    ws_sender.send(axum::extract::ws::Message::Text("3.nop;".into())).await?;

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            if !send_buffer.is_empty() {
                ws_sender.send(axum::extract::ws::Message::Text(send_buffer)).await?;
            }
            break;
        }

        parser.push(&buf[..n]);

        while let Some(instruction) = parser.next_instruction() {
            // Check for sync instruction to handle pacing
            if instruction.opcode == b"sync" {
                if let Some(ts_bytes) = instruction.args.get(0) {
                    if let Ok(ts_str) = std::str::from_utf8(ts_bytes) {
                        if let Ok(ts) = ts_str.parse::<u64>() {
                            match (base_guac_ts, base_real_ts) {
                                (None, None) => {
                                    base_guac_ts = Some(ts);
                                    base_real_ts = Some(std::time::Instant::now());
                                }
                                (Some(b_ts), Some(b_real)) => {
                                    let guac_elapsed = ts.saturating_sub(b_ts);
                                    let real_elapsed = std::time::Instant::now().duration_since(b_real).as_millis() as u64;

                                    if guac_elapsed > real_elapsed {
                                        // Flush buffer before wait
                                        if !send_buffer.is_empty() {
                                            let payload = std::mem::take(&mut send_buffer);
                                            ws_sender.send(axum::extract::ws::Message::Text(payload)).await?;
                                        }

                                        let wait_ms = guac_elapsed - real_elapsed;
                                        // Keep-alive for long waits
                                        if wait_ms > 5000 {
                                            let mut remaining = wait_ms;
                                            while remaining > 5000 {
                                                tokio::time::sleep(std::time::Duration::from_millis(5000)).await;
                                                ws_sender.send(axum::extract::ws::Message::Text("3.nop;".into())).await?;
                                                remaining -= 5000;
                                            }
                                            tokio::time::sleep(std::time::Duration::from_millis(remaining)).await;
                                        } else {
                                            tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                                        }
                                    }

                                    // Periodic progress update
                                    if last_progress_sent.elapsed().as_millis() > 500 {
                                        let prog = format!("{}.nvrprogress,{}.{};", "nvrprogress".len(), guac_elapsed.to_string().len(), guac_elapsed);
                                        send_buffer.push_str(&prog);
                                        last_progress_sent = std::time::Instant::now();
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }

            // Aggregate with lossy UTF-8
            send_buffer.push_str(&String::from_utf8_lossy(&instruction.raw));

            // Flush threshold
            if send_buffer.len() >= 16384 {
                ws_sender.send(axum::extract::ws::Message::Text(std::mem::take(&mut send_buffer))).await?;
            }
        }
    }

    Ok(())
}

struct GuacamoleInstruction {
    opcode: Vec<u8>,
    args: Vec<Vec<u8>>,
    raw: Vec<u8>,
}

struct GuacamoleParser {
    buffer: Vec<u8>,
}

impl GuacamoleParser {
    fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    fn push(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }

    fn next_instruction(&mut self) -> Option<GuacamoleInstruction> {
        let mut elements = Vec::new();
        let mut cursor = 0;

        loop {
            let remaining = &self.buffer[cursor..];
            let dot_pos = match remaining.iter().position(|&b| b == b'.') {
                Some(p) => p,
                None => return None,
            };

            let len_str = match std::str::from_utf8(&remaining[..dot_pos]) {
                Ok(s) => s,
                Err(_) => {
                    tracing::error!("Invalid UTF-8 in length prefix: {:?}", &remaining[..dot_pos]);
                    self.buffer.clear();
                    return None;
                }
            };
            
            let len: usize = match len_str.parse() {
                Ok(l) => l,
                Err(_) => {
                    tracing::error!("Failed to parse length prefix: '{}'", len_str);
                    self.buffer.clear();
                    return None;
                }
            };
            
            let content_start = cursor + dot_pos + 1;
            
            // Strictly follow Guacamole's character counting
            // Guacamole protocol counts Unicode characters, NOT bytes.
            let mut char_count = 0;
            let mut check_pos = content_start;
            
            while char_count < len {
                if check_pos >= self.buffer.len() {
                    return None; // Need more data
                }
                
                let b = self.buffer[check_pos];
                // In UTF-8, characters start with 0xxxxxxx or 11xxxxxx.
                // Continuation bytes (10xxxxxx) do NOT start a character.
                if (b & 0xC0) != 0x80 {
                    char_count += 1;
                }
                check_pos += 1;
            }

            // Consume all continuation bytes of the final character
            while check_pos < self.buffer.len() && (self.buffer[check_pos] & 0xC0) == 0x80 {
                check_pos += 1;
            }

            if check_pos >= self.buffer.len() {
                return None; // Need more data (terminator)
            }

            let content_bytes = self.buffer[content_start..check_pos].to_vec();
            elements.push(content_bytes);

            let terminator = self.buffer[check_pos];
            if terminator == b';' {
                let total_len = check_pos + 1;
                let raw = self.buffer[..total_len].to_vec();
                self.buffer.drain(..total_len);
                
                let opcode = elements.remove(0);
                return Some(GuacamoleInstruction {
                    opcode,
                    args: elements,
                    raw,
                });
            } else if terminator == b',' {
                cursor = check_pos + 1;
                continue;
            } else {
                // If we reach here, we hit a byte that isn't , or ; where we expected a terminator.
                // This means our character counting desynced OR the input is malformed.
                // We MUST recover by skipping and trying to find the next valid length prefix.
                tracing::warn!("Protocol desync: expected terminator, found {}. Attempting recovery.", terminator);
                self.buffer.clear(); // Simple recovery for now
                return None;
            }
        }
    }
}
