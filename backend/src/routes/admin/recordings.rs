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
use crate::services::app_state::SharedState;


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

    let mut parser = GuacamoleParser::new();
    let mut buf = [0u8; 16384];

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }

        parser.push(&buf[..n]);

        while let Some(instruction) = parser.next_instruction() {
            let raw_str = String::from_utf8_lossy(&instruction.raw).to_string();
            // tracing::debug!("Proxying instruction: {}", raw_str);
            socket.send(axum::extract::ws::Message::Text(raw_str)).await?;
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
