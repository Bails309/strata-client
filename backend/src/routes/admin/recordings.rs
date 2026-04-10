// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use futures_util::StreamExt;

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
    let (db, _config) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let cfg = s.config.clone().ok_or(AppError::SetupRequired)?;
        (db, cfg)
    };

    // Fetch recording metadata
    let recording: Recording = sqlx::query_as("SELECT * FROM recordings WHERE id = $1")
        .bind(id)
        .fetch_optional(&db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Recording not found".into()))?;

    Ok(ws.on_upgrade(move |socket| async move {
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
        // Azure storage stream
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

    // Send NVR header with total duration
    let duration_ms = recording.duration_secs.unwrap_or(0) * 1000;
    let header = format!("{}.nvrheader,{}.{};", "nvrheader".len(), duration_ms.to_string().len(), duration_ms);
    socket.send(axum::extract::ws::Message::Text(header)).await?;

    let mut parser = GuacamoleParser::new();
    let mut base_guac_ts: Option<u64> = None;
    let mut base_real_ts: Option<std::time::Instant> = None;
    let mut last_progress_sent = std::time::Instant::now();

    let mut buf = [0u8; 16384];

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }

        parser.push(&buf[..n]);

        while let Some(instruction) = parser.next_instruction() {
            // Check for sync instruction to handle pacing
            if instruction.opcode == "sync" {
                if let Some(ts_str) = instruction.args.get(0) {
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
                                    tokio::time::sleep(std::time::Duration::from_millis(guac_elapsed - real_elapsed)).await;
                                }

                                // Send progress update periodically (every 500ms at most)
                                if last_progress_sent.elapsed().as_millis() > 500 {
                                    let prog = format!("{}.nvrprogress,{}.{};", "nvrprogress".len(), guac_elapsed.to_string().len(), guac_elapsed);
                                    socket.send(axum::extract::ws::Message::Text(prog)).await?;
                                    last_progress_sent = std::time::Instant::now();
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }

            // Send standard instruction
            socket.send(axum::extract::ws::Message::Text(instruction.raw)).await?;
        }
    }

    Ok(())
}

struct GuacamoleInstruction {
    opcode: String,
    args: Vec<String>,
    raw: String,
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
            let dot_pos = remaining.iter().position(|&b| b == b'.')?;
            
            let len_str = std::str::from_utf8(&remaining[..dot_pos]).ok()?;
            let len: usize = len_str.parse().ok()?;
            
            let content_start = cursor + dot_pos + 1;
            
            // Find the byte-offset for 'len' UTF-8 characters
            let mut char_count = 0;
            let mut check_pos = content_start;
            
            while char_count < len {
                if check_pos >= self.buffer.len() {
                    return None; // Need more data
                }
                
                // UTF-8 lead byte check: 
                // 1-byte: 0xxxxxxx
                // 2-byte: 110xxxxx
                // 3-byte: 1110xxxx
                // 4-byte: 11110xxx
                // Continuation bytes are 10xxxxxx
                let b = self.buffer[check_pos];
                if (b & 0xC0) != 0x80 {
                    char_count += 1;
                }
                check_pos += 1;
            }

            // We've found the start of 'len' characters, but we need to consume 
            // any continuation bytes of the LAST character to reach the terminator.
            while check_pos < self.buffer.len() && (self.buffer[check_pos] & 0xC0) == 0x80 {
                check_pos += 1;
            }

            if check_pos >= self.buffer.len() {
                return None; // Need more data (terminator)
            }

            let content_bytes = &self.buffer[content_start..check_pos];
            let content = std::str::from_utf8(content_bytes).ok()?.to_string();
            elements.push(content);

            let terminator = self.buffer[check_pos] as char;
            if terminator == ';' {
                let total_len = check_pos + 1;
                let raw = String::from_utf8_lossy(&self.buffer[..total_len]).to_string();
                self.buffer.drain(..total_len);
                
                let opcode = elements.remove(0);
                return Some(GuacamoleInstruction {
                    opcode,
                    args: elements,
                    raw,
                });
            } else if terminator == ',' {
                cursor = check_pos + 1;
                continue;
            } else {
                // Malformed instruction, clear buffer
                self.buffer.clear();
                return None;
            }
        }
    }
}
