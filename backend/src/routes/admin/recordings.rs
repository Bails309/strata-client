// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::db::Recording;
use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};

// ── Session Statistics ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct SessionStats {
    pub total_sessions: i64,
    pub total_hours: f64,
    pub unique_users: i64,
    pub active_now: u32,
    pub avg_duration_mins: f64,
    pub median_duration_mins: f64,
    pub total_bandwidth_bytes: i64,
    pub top_connections: Vec<TopConnection>,
    pub top_users: Vec<TopUser>,
    pub daily_trend: Vec<DailyTrend>,
    pub protocol_distribution: Vec<ProtocolDistribution>,
    pub peak_hours: Vec<PeakHour>,
}

#[derive(Serialize)]
pub struct TopConnection {
    pub name: String,
    pub protocol: String,
    pub sessions: i64,
    pub total_hours: f64,
}

#[derive(Serialize, sqlx::FromRow)]
struct TopConnectionRow {
    name: String,
    protocol: String,
    sessions: i64,
    total_hours: f64,
}

#[derive(Serialize)]
pub struct TopUser {
    pub username: String,
    pub sessions: i64,
    pub total_hours: f64,
    pub last_session: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct TopUserRow {
    username: String,
    sessions: i64,
    total_hours: f64,
    last_session: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Serialize)]
pub struct DailyTrend {
    pub date: String,
    pub sessions: i64,
    pub hours: f64,
    pub unique_users: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct DailyTrendRow {
    date: chrono::NaiveDate,
    sessions: i64,
    hours: f64,
    unique_users: i64,
}

#[derive(Serialize)]
pub struct ProtocolDistribution {
    pub protocol: String,
    pub sessions: i64,
    pub total_hours: f64,
}

#[derive(Serialize, sqlx::FromRow)]
struct ProtocolDistributionRow {
    protocol: String,
    sessions: i64,
    total_hours: f64,
}

#[derive(Serialize)]
pub struct PeakHour {
    pub hour: i32,
    pub sessions: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct PeakHourRow {
    hour: f64,
    sessions: i64,
}

/// GET /api/admin/session-stats – aggregate session statistics for the dashboard.
pub async fn session_stats(
    State(state): State<SharedState>,
    Extension(user): Extension<crate::services::middleware::AuthUser>,
) -> Result<Json<SessionStats>, AppError> {
    crate::services::middleware::check_session_permission(&user)?;

    let (db, active_now) = {
        let s = state.read().await;
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let active = s.session_registry.list().await.len() as u32;
        (db, active)
    };

    // Combine scalar aggregates into a single query using a CTE
    let (total_sessions, total_hours, unique_users, avg_duration_mins, median_duration_mins, total_bandwidth_bytes): (i64, f64, i64, f64, f64, i64) = sqlx::query_as(
        "WITH cutoff_data AS (
            SELECT * FROM recordings WHERE started_at >= NOW() - INTERVAL '30 days'
        )
        SELECT
            (SELECT COUNT(*) FROM cutoff_data),
            (SELECT COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) FROM cutoff_data),
            (SELECT COUNT(DISTINCT user_id) FROM cutoff_data),
            (SELECT COALESCE(AVG(duration_secs::float) / 60.0, 0.0) FROM cutoff_data WHERE duration_secs IS NOT NULL),
            (SELECT COALESCE((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_secs))::float / 60.0, 0.0) FROM cutoff_data WHERE duration_secs IS NOT NULL),
            (SELECT COALESCE(SUM(COALESCE(bytes_from_guacd, 0) + COALESCE(bytes_to_guacd, 0)), 0)::bigint FROM cutoff_data)"
    )
    .fetch_one(&db.pool)
    .await?;

    // Daily trend (last 30 days)
    let daily_trend: Vec<DailyTrendRow> = sqlx::query_as(
        "SELECT started_at::date AS date,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS hours,
                COUNT(DISTINCT user_id) AS unique_users
         FROM recordings
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY started_at::date
         ORDER BY date"
    )
    .fetch_all(&db.pool)
    .await?;

    // Protocol distribution
    let protocol_distribution: Vec<ProtocolDistributionRow> = sqlx::query_as(
        "SELECT COALESCE((SELECT protocol FROM connections c WHERE c.id = r.connection_id), 'unknown') AS protocol,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS total_hours
         FROM recordings r
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY protocol
         ORDER BY sessions DESC"
    )
    .fetch_all(&db.pool)
    .await?;

    // Peak hours (0-23)
    let peak_hours: Vec<PeakHourRow> = sqlx::query_as(
        "SELECT EXTRACT(HOUR FROM started_at)::float AS hour,
                COUNT(*) AS sessions
         FROM recordings
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY hour
         ORDER BY hour"
    )
    .fetch_all(&db.pool)
    .await?;

    let top_connections: Vec<TopConnectionRow> = sqlx::query_as(
        "SELECT connection_name AS name,
                COALESCE((SELECT protocol FROM connections c WHERE c.id = r.connection_id), 'rdp') AS protocol,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS total_hours
         FROM recordings r
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY connection_id, connection_name
         ORDER BY sessions DESC
         LIMIT 10"
    )
    .fetch_all(&db.pool)
    .await?;

    let top_users: Vec<TopUserRow> = sqlx::query_as(
        "SELECT username,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS total_hours,
                MAX(started_at) AS last_session
         FROM recordings
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY user_id, username
         ORDER BY sessions DESC
         LIMIT 10"
    )
    .fetch_all(&db.pool)
    .await?;

    Ok(Json(SessionStats {
        total_sessions,
        total_hours: (total_hours * 10.0).round() / 10.0,
        unique_users,
        active_now,
        avg_duration_mins: (avg_duration_mins * 10.0).round() / 10.0,
        median_duration_mins: (median_duration_mins * 10.0).round() / 10.0,
        total_bandwidth_bytes,
        top_connections: top_connections
            .into_iter()
            .map(|r| TopConnection {
                name: r.name,
                protocol: r.protocol,
                sessions: r.sessions,
                total_hours: (r.total_hours * 10.0).round() / 10.0,
            })
            .collect(),
        top_users: top_users
            .into_iter()
            .map(|r| TopUser {
                username: r.username,
                sessions: r.sessions,
                total_hours: (r.total_hours * 10.0).round() / 10.0,
                last_session: r.last_session.map(|d| d.to_rfc3339()),
            })
            .collect(),
        daily_trend: daily_trend
            .into_iter()
            .map(|r| DailyTrend {
                date: r.date.to_string(),
                sessions: r.sessions,
                hours: (r.hours * 10.0).round() / 10.0,
                unique_users: r.unique_users,
            })
            .collect(),
        protocol_distribution: protocol_distribution
            .into_iter()
            .map(|r| ProtocolDistribution {
                protocol: r.protocol,
                sessions: r.sessions,
                total_hours: (r.total_hours * 10.0).round() / 10.0,
            })
            .collect(),
        peak_hours: peak_hours
            .into_iter()
            .map(|r| PeakHour {
                hour: r.hour as i32,
                sessions: r.sessions,
            })
            .collect(),
    }))
}

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
         LIMIT $3 OFFSET $4",
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
    Query(query): Query<RecordingStreamQuery>,
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

    let seek_ms = query.seek.unwrap_or(0);
    let speed = query.speed.unwrap_or(1.0).clamp(0.25, 16.0);

    Ok(ws
        .protocols(["guacamole"])
        .on_upgrade(move |socket| async move {
            if let Err(e) = handle_recording_stream(socket, state, recording, seek_ms, speed).await
            {
                tracing::error!("Recording stream error: {e}");
            }
        }))
}

/// Public wrapper so the user recording route can reuse the stream logic.
pub async fn handle_user_recording_stream(
    socket: axum::extract::ws::WebSocket,
    state: SharedState,
    recording: Recording,
    seek_ms: u64,
    speed: f64,
) -> anyhow::Result<()> {
    handle_recording_stream(socket, state, recording, seek_ms, speed).await
}

async fn handle_recording_stream(
    mut socket: axum::extract::ws::WebSocket,
    state: SharedState,
    recording: Recording,
    seek_ms: u64,
    initial_speed: f64,
) -> anyhow::Result<()> {
    let mut paused = false;
    let mut speed = initial_speed;
    let mut seeking = seek_ms > 0;
    let mut pause_offset = std::time::Duration::ZERO;

    /// Drain any pending client messages (keepalive pings, nvrpause/nvrresume/nvrspeed)
    /// without blocking. Returns the updated (paused, speed) state.
    async fn drain_incoming(
        socket: &mut axum::extract::ws::WebSocket,
        mut paused: bool,
        mut speed: f64,
    ) -> (bool, f64) {
        loop {
            tokio::select! {
                biased;
                msg = socket.next() => {
                    match msg {
                        Some(Ok(axum::extract::ws::Message::Text(ref text))) => {
                            let t: &str = text;
                            if t == "8.nvrpause;" {
                                paused = true;
                            } else if t == "9.nvrresume;" {
                                paused = false;
                            } else if let Some(s) = parse_nvrspeed(t) {
                                speed = s;
                            }
                        }
                        Some(Ok(_)) => {} // ignore binary/ping/pong
                        _ => break,       // closed or error
                    }
                }
                _ = std::future::ready(()) => {
                    // No message ready right now — stop draining
                    break;
                }
            }
        }
        (paused, speed)
    }

    let mut reader = if recording.storage_type == "local" {
        let path = format!("/var/lib/guacamole/recordings/{}", recording.storage_path);
        tracing::info!(
            "Opening local recording: id={}, path={}",
            recording.id,
            path
        );
        let file = tokio::fs::File::open(&path).await.map_err(|e| {
            tracing::error!(
                "Failed to open recording file: id={}, path={}, err={}",
                recording.id,
                path,
                e
            );
            e
        })?;
        Box::new(tokio::io::BufReader::new(file)) as Box<dyn tokio::io::AsyncRead + Unpin + Send>
    } else {
        // Azure storage stream
        let azure = {
            let s = state.read().await;
            let pool =
                s.db.as_ref()
                    .ok_or_else(|| anyhow::anyhow!("DB not connected"))?
                    .pool
                    .clone();
            let vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).cloned();
            crate::services::recordings::get_azure_config(&pool, vault.as_ref()).await?
        };
        if let Some(azure) = azure {
            let stream = crate::services::recordings::download_stream_from_azure(
                &azure,
                &recording.storage_path,
            )
            .await?;
            let reader = tokio_util::io::StreamReader::new(
                stream.map(|res: reqwest::Result<bytes::Bytes>| res.map_err(std::io::Error::other)),
            );
            Box::new(tokio::io::BufReader::new(reader))
                as Box<dyn tokio::io::AsyncRead + Unpin + Send>
        } else {
            anyhow::bail!("Azure storage not configured");
        }
    };

    // Send NVR header with total duration
    let duration_ms = recording.duration_secs.unwrap_or(0) * 1000;
    let duration_str = duration_ms.to_string();
    let header = format_guac_instruction("nvrheader", &[&duration_str]);
    socket
        .send(axum::extract::ws::Message::Text(header))
        .await?;

    let mut parser = GuacamoleParser::new();
    let mut first_guac_ts: Option<u64> = None; // never changes — for absolute progress
    let mut base_guac_ts: Option<u64> = None; // reset on speed change — for pacing
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
                if let Some(ts_str) = instruction.args.first() {
                    if let Ok(ts) = ts_str.parse::<u64>() {
                        match (base_guac_ts, base_real_ts) {
                            (None, None) => {
                                first_guac_ts = Some(ts);
                                base_guac_ts = Some(ts);
                                base_real_ts = Some(std::time::Instant::now());
                            }
                            (Some(b_ts), Some(b_real)) => {
                                let first_ts = first_guac_ts.unwrap_or(b_ts);
                                let abs_elapsed = ts.saturating_sub(first_ts);

                                // ── Seeking: fast-forward without pacing ──
                                if seeking {
                                    if abs_elapsed >= seek_ms {
                                        // Seek complete — reset timing for normal playback
                                        seeking = false;
                                        base_guac_ts = Some(ts);
                                        base_real_ts = Some(std::time::Instant::now());
                                        pause_offset = std::time::Duration::ZERO;
                                        let seeked = format_guac_instruction(
                                            "nvrseeked",
                                            &[&abs_elapsed.to_string()],
                                        );
                                        socket
                                            .send(axum::extract::ws::Message::Text(seeked))
                                            .await?;
                                    } else if last_progress_sent.elapsed().as_millis() > 200 {
                                        let prog = format_guac_instruction(
                                            "nvrprogress",
                                            &[&abs_elapsed.to_string()],
                                        );
                                        let _ = socket
                                            .send(axum::extract::ws::Message::Text(prog))
                                            .await;
                                        last_progress_sent = std::time::Instant::now();
                                    }
                                }

                                if !seeking {
                                    // ── Drain pending messages (incl. speed) ──
                                    let (p, s) = drain_incoming(&mut socket, paused, speed).await;
                                    paused = p;
                                    if s != speed {
                                        speed = s;
                                        base_guac_ts = Some(ts);
                                        base_real_ts = Some(std::time::Instant::now());
                                        pause_offset = std::time::Duration::ZERO;
                                    }

                                    // ── Pause loop ──
                                    if paused {
                                        let pause_start = std::time::Instant::now();
                                        while paused {
                                            tokio::select! {
                                                biased;
                                                msg = socket.next() => {
                                                    match msg {
                                                        Some(Ok(axum::extract::ws::Message::Text(ref t))) => {
                                                            let sv: &str = t;
                                                            if sv == "9.nvrresume;" {
                                                                paused = false;
                                                            } else if let Some(ns) = parse_nvrspeed(sv) {
                                                                speed = ns;
                                                            }
                                                        }
                                                        Some(Err(_)) | None => {
                                                            return Ok(());
                                                        }
                                                        _ => {}
                                                    }
                                                }
                                                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                                                    socket.send(axum::extract::ws::Message::Text("3.nop;".into())).await?;
                                                }
                                            }
                                        }
                                        pause_offset +=
                                            std::time::Instant::now().duration_since(pause_start);
                                    }

                                    // ── Speed-adjusted pacing ──
                                    let guac_elapsed =
                                        ts.saturating_sub(base_guac_ts.unwrap_or(b_ts));
                                    let wall_elapsed = std::time::Instant::now()
                                        .duration_since(base_real_ts.unwrap_or(b_real));
                                    let real_ms =
                                        wall_elapsed.saturating_sub(pause_offset).as_millis()
                                            as u64;
                                    let target_wall = (guac_elapsed as f64 / speed) as u64;

                                    if target_wall > real_ms {
                                        let total_wall = target_wall - real_ms;
                                        let mut remaining_wall = total_wall;
                                        while remaining_wall > 0 {
                                            let chunk = remaining_wall.min(500);
                                            tokio::select! {
                                                biased;
                                                msg = socket.next() => {
                                                    match msg {
                                                        Some(Ok(axum::extract::ws::Message::Text(ref t))) => {
                                                            let sv: &str = t;
                                                            if sv == "8.nvrpause;" {
                                                                paused = true;
                                                                let pause_start = std::time::Instant::now();
                                                                while paused {
                                                                    tokio::select! {
                                                                        biased;
                                                                        msg2 = socket.next() => {
                                                                            match msg2 {
                                                                                Some(Ok(axum::extract::ws::Message::Text(ref t2))) => {
                                                                                    let s2: &str = t2;
                                                                                    if s2 == "9.nvrresume;" {
                                                                                        paused = false;
                                                                                    } else if let Some(ns) = parse_nvrspeed(s2) {
                                                                                        speed = ns;
                                                                                    }
                                                                                }
                                                                                Some(Err(_)) | None => return Ok(()),
                                                                                _ => {}
                                                                            }
                                                                        }
                                                                        _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                                                                            socket.send(axum::extract::ws::Message::Text("3.nop;".into())).await?;
                                                                        }
                                                                    }
                                                                }
                                                                pause_offset += std::time::Instant::now().duration_since(pause_start);
                                                                // Recalculate with new speed/pause offset
                                                                let new_wall = std::time::Instant::now().duration_since(base_real_ts.unwrap_or(b_real));
                                                                let new_real = new_wall.saturating_sub(pause_offset).as_millis() as u64;
                                                                let new_target = (guac_elapsed as f64 / speed) as u64;
                                                                remaining_wall = new_target.saturating_sub(new_real);
                                                            } else if let Some(ns) = parse_nvrspeed(sv) {
                                                                speed = ns;
                                                                base_guac_ts = Some(ts);
                                                                base_real_ts = Some(std::time::Instant::now());
                                                                pause_offset = std::time::Duration::ZERO;
                                                                remaining_wall = 0;
                                                            }
                                                        }
                                                        Some(Err(_)) | None => return Ok(()),
                                                        _ => {}
                                                    }
                                                }
                                                _ = tokio::time::sleep(std::time::Duration::from_millis(chunk)) => {
                                                    remaining_wall -= chunk;
                                                    // Smooth progress: interpolate absolute position
                                                    let remaining_guac = (remaining_wall as f64 * speed) as u64;
                                                    let interp = abs_elapsed.saturating_sub(remaining_guac);
                                                    let prog = format_guac_instruction("nvrprogress", &[&interp.to_string()]);
                                                    socket.send(axum::extract::ws::Message::Text(prog)).await?;
                                                    last_progress_sent = std::time::Instant::now();
                                                }
                                            }
                                        }
                                    }

                                    // Send progress update periodically
                                    if last_progress_sent.elapsed().as_millis() > 500 {
                                        let prog = format_guac_instruction(
                                            "nvrprogress",
                                            &[&abs_elapsed.to_string()],
                                        );
                                        socket.send(axum::extract::ws::Message::Text(prog)).await?;
                                        last_progress_sent = std::time::Instant::now();
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }

            // During seeking, skip sending sync instructions so the Guacamole
            // client accumulates all drawing ops into ONE frame instead of
            // queuing hundreds of intermediate frames (which causes a black
            // screen or fast-replay artefact).  Non-sync drawing instructions
            // are always sent so the display state builds up correctly.
            if !(seeking && instruction.opcode == "sync") {
                socket
                    .send(axum::extract::ws::Message::Text(instruction.raw))
                    .await?;
            }
        }
    }

    // Signal end-of-recording so the frontend can close gracefully
    let end_msg = format_guac_instruction("nvrend", &[]);
    let _ = socket.send(axum::extract::ws::Message::Text(end_msg)).await;
    let _ = socket.send(axum::extract::ws::Message::Close(None)).await;

    Ok(())
}

/// Format a Guacamole protocol instruction from an opcode and arguments.
/// Each element is length-prefixed (`len.value`), separated by commas, terminated by semicolon.
pub fn format_guac_instruction(opcode: &str, args: &[&str]) -> String {
    let mut out = format!("{}.{}", opcode.len(), opcode);
    for arg in args {
        out.push_str(&format!(",{}.{}", arg.len(), arg));
    }
    out.push(';');
    out
}

/// Parse an `nvrspeed` Guacamole message like `8.nvrspeed,1.4;` into the speed value.
fn parse_nvrspeed(msg: &str) -> Option<f64> {
    let rest = msg.strip_prefix("8.nvrspeed,")?;
    let rest = rest.strip_suffix(';')?;
    let dot = rest.find('.')?;
    let value = &rest[dot + 1..];
    value
        .parse::<f64>()
        .ok()
        .filter(|&v| (0.25..=16.0).contains(&v))
}

/// Query parameters for recording stream endpoints.
#[derive(Deserialize)]
pub struct RecordingStreamQuery {
    /// Seek to this position in the recording (milliseconds from start).
    /// The backend fast-forwards without pacing until reaching this point.
    pub seek: Option<u64>,
    /// Initial playback speed multiplier (default 1.0). Range [0.25, 16].
    pub speed: Option<f64>,
}

struct GuacamoleInstruction {
    opcode: String,
    args: Vec<String>,
    raw: String,
}

struct GuacamoleParser {
    buffer: String,
}

impl GuacamoleParser {
    fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    fn push(&mut self, data: &[u8]) {
        self.buffer.push_str(&String::from_utf8_lossy(data));
    }

    fn next_instruction(&mut self) -> Option<GuacamoleInstruction> {
        let mut elements = Vec::new();
        let mut cursor_bytes = 0;

        loop {
            // Find length prefix
            let remaining = &self.buffer[cursor_bytes..];
            let dot_pos = remaining.find('.')?;

            let len_str = &remaining[..dot_pos];
            let len: usize = match len_str.parse() {
                Ok(l) => l,
                Err(_) => {
                    // Malformed prefix, clear and stop
                    self.buffer.clear();
                    return None;
                }
            };

            let content_start_bytes = cursor_bytes + dot_pos + 1;
            let after_prefix = &self.buffer[content_start_bytes..];

            // We need 'len' characters. Find the byte offset for 'len' characters.
            let mut char_count = 0;
            let mut content_end_offset = 0;
            let mut found_end = false;
            for (i, _) in after_prefix.char_indices() {
                if char_count == len {
                    content_end_offset = i;
                    found_end = true;
                    break;
                }
                char_count += 1;
            }

            if char_count < len {
                return None; // Need more data
            }

            // Content ends exactly at buffer boundary — terminator not yet available
            if !found_end {
                return None;
            }

            let content = &after_prefix[..content_end_offset];
            elements.push(content.to_string());

            let terminator_pos = content_start_bytes + content_end_offset;
            if terminator_pos >= self.buffer.len() {
                return None; // Need more data (terminator)
            }

            let terminator = self.buffer.as_bytes()[terminator_pos] as char;
            if terminator == ';' {
                let raw = self.buffer[..=terminator_pos].to_string();
                self.buffer.drain(..=terminator_pos);

                let opcode = elements.remove(0);
                return Some(GuacamoleInstruction {
                    opcode,
                    args: elements,
                    raw,
                });
            } else if terminator == ',' {
                cursor_bytes = terminator_pos + 1;
                continue;
            } else {
                // Malformed
                self.buffer.clear();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parser_simple() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"4.test,5.hello;");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "test");
        assert_eq!(inst.args, vec!["hello"]);
        assert_eq!(inst.raw, "4.test,5.hello;");
    }

    #[test]
    fn test_parser_multi_part() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"4.test,5.hello,5.world;");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "test");
        assert_eq!(inst.args, vec!["hello", "world"]);
    }

    #[test]
    fn test_parser_unicode() {
        let mut parser = GuacamoleParser::new();
        // Guacamole protocol counts characters, not bytes.
        // 🚀 is 1 character but 4 bytes in UTF-8.
        parser.push("1.🚀,5.world;".as_bytes());
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "🚀");
        assert_eq!(inst.args, vec!["world"]);
    }

    #[test]
    fn test_parser_partial() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"4.te");
        assert!(parser.next_instruction().is_none());
        parser.push(b"st,5.hel");
        assert!(parser.next_instruction().is_none());
        parser.push(b"lo;");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "test");
        assert_eq!(inst.args, vec!["hello"]);
    }

    #[test]
    fn test_parser_malformed_prefix() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"abc.test,5.hello;");
        assert!(parser.next_instruction().is_none());
        assert!(parser.buffer.is_empty());
    }

    #[test]
    fn test_parser_malformed_terminator() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"4.test?5.hello;");
        assert!(parser.next_instruction().is_none());
        assert!(parser.buffer.is_empty());
    }

    #[test]
    fn test_parser_empty_arg() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"4.test,0.,5.world;");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "test");
        assert_eq!(inst.args, vec!["", "world"]);
    }

    #[test]
    fn test_parser_multiple_instructions() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"4.inst,1.1;4.inst,1.2;");

        let inst1 = parser.next_instruction().unwrap();
        assert_eq!(inst1.opcode, "inst");
        assert_eq!(inst1.args, vec!["1"]);

        let inst2 = parser.next_instruction().unwrap();
        assert_eq!(inst2.opcode, "inst");
        assert_eq!(inst2.args, vec!["2"]);

        assert!(parser.next_instruction().is_none());
    }

    // ── Additional GuacamoleParser tests ───────────────────────────

    #[test]
    fn test_parser_chunk_boundary() {
        // Content ends exactly at 16KB chunk boundary
        let mut parser = GuacamoleParser::new();
        let data = "a".repeat(100);
        let inst = format!("100.{data};");
        parser.push(inst.as_bytes());
        let result = parser.next_instruction().unwrap();
        assert_eq!(result.opcode, data);
        assert!(result.args.is_empty());
    }

    #[test]
    fn test_parser_incremental_bytes() {
        let mut parser = GuacamoleParser::new();
        let full = b"4.sync,13.1617091200000;";
        // Push one byte at a time
        for &b in full.iter() {
            parser.push(&[b]);
        }
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "sync");
        assert_eq!(inst.args, vec!["1617091200000"]);
    }

    #[test]
    fn test_parser_no_args_instruction() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"3.nop;");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "nop");
        assert!(inst.args.is_empty());
        assert_eq!(inst.raw, "3.nop;");
    }

    #[test]
    fn test_parser_large_instruction() {
        let mut parser = GuacamoleParser::new();
        let large = "b".repeat(5000);
        let inst = format!("5000.{large};");
        parser.push(inst.as_bytes());
        let result = parser.next_instruction().unwrap();
        assert_eq!(result.opcode, large);
    }

    #[test]
    fn test_parser_buffer_clears_on_malformed() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"abc.broken;");
        assert!(parser.next_instruction().is_none());
        assert!(parser.buffer.is_empty());
        // After clear, new valid data works
        parser.push(b"3.nop;");
        assert!(parser.next_instruction().is_some());
    }

    #[test]
    fn test_parser_three_args() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"4.size,4.1920,4.1080,2.96;");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "size");
        assert_eq!(inst.args, vec!["1920", "1080", "96"]);
    }

    #[test]
    fn test_parser_multiple_unicode() {
        let mut parser = GuacamoleParser::new();
        // "é" is 1 char, 2 bytes. "中" is 1 char, 3 bytes.
        parser.push("1.é,1.中;".as_bytes());
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "é");
        assert_eq!(inst.args, vec!["中"]);
    }

    #[test]
    fn test_parser_consecutive_after_partial() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"3.img,5.hello;3.nop;");
        let inst1 = parser.next_instruction().unwrap();
        assert_eq!(inst1.opcode, "img");
        assert_eq!(inst1.args, vec!["hello"]);
        let inst2 = parser.next_instruction().unwrap();
        assert_eq!(inst2.opcode, "nop");
        assert!(parser.next_instruction().is_none());
    }

    #[test]
    fn test_parser_raw_preserved() {
        let mut parser = GuacamoleParser::new();
        let raw = "4.sync,13.1617091200000;";
        parser.push(raw.as_bytes());
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.raw, raw);
    }

    #[test]
    fn test_parser_empty_opcode() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"0.,5.hello;");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "");
        assert_eq!(inst.args, vec!["hello"]);
    }

    #[test]
    fn test_parser_waiting_for_terminator() {
        let mut parser = GuacamoleParser::new();
        // Push data without terminator
        parser.push(b"3.nop");
        assert!(parser.next_instruction().is_none());
        // Complete with terminator
        parser.push(b";");
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "nop");
    }

    #[test]
    fn test_parser_new_is_empty() {
        let mut parser = GuacamoleParser::new();
        assert!(parser.next_instruction().is_none());
    }

    #[test]
    fn test_parser_push_empty() {
        let mut parser = GuacamoleParser::new();
        parser.push(b"");
        assert!(parser.next_instruction().is_none());
    }

    // ── format_guac_instruction tests ───────────────────────────

    #[test]
    fn format_guac_no_args() {
        assert_eq!(format_guac_instruction("nvrend", &[]), "6.nvrend;");
    }

    #[test]
    fn format_guac_one_arg() {
        assert_eq!(
            format_guac_instruction("nvrheader", &["5000"]),
            "9.nvrheader,4.5000;"
        );
    }

    #[test]
    fn format_guac_multiple_args() {
        assert_eq!(
            format_guac_instruction("size", &["1920", "1080", "96"]),
            "4.size,4.1920,4.1080,2.96;"
        );
    }

    #[test]
    fn format_guac_nop() {
        assert_eq!(format_guac_instruction("nop", &[]), "3.nop;");
    }

    #[test]
    fn format_guac_empty_arg() {
        assert_eq!(format_guac_instruction("test", &[""]), "4.test,0.;");
    }

    #[test]
    fn format_guac_roundtrips_with_parser() {
        let wire = format_guac_instruction("sync", &["1617091200000"]);
        let mut parser = GuacamoleParser::new();
        parser.push(wire.as_bytes());
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.opcode, "sync");
        assert_eq!(inst.args, vec!["1617091200000"]);
    }

    #[test]
    fn format_guac_nvrprogress() {
        let elapsed = 12345u64;
        let elapsed_str = elapsed.to_string();
        let result = format_guac_instruction("nvrprogress", &[&elapsed_str]);
        assert_eq!(result, "11.nvrprogress,5.12345;");
    }
}
