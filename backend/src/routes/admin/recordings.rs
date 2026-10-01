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

#[derive(Serialize, Clone)]
pub struct SessionStats {
    pub total_sessions: i64,
    pub total_hours: f64,
    pub unique_users: i64,
    pub active_now: u32,
    pub avg_duration_mins: f64,
    pub median_duration_mins: f64,
    pub total_bandwidth_bytes: i64,
    /// Every figure above bar `active_now` is derived from the recordings
    /// table, so with recording off they read zero however busy the gateway is.
    pub recording_enabled: bool,
    /// When the historical figures were computed (they are cached for
    /// [`STATS_TTL`]); `active_now` is always live.
    pub generated_at: String,
    pub top_connections: Vec<TopConnection>,
    pub top_users: Vec<TopUser>,
    pub daily_trend: Vec<DailyTrend>,
    pub protocol_distribution: Vec<ProtocolDistribution>,
    pub peak_hours: Vec<PeakHour>,
}

#[derive(Serialize, Clone)]
pub struct TopConnection {
    pub name: String,
    pub protocol: String,
    pub sessions: i64,
    pub total_hours: f64,
}

#[derive(Serialize, Clone)]
pub struct TopUser {
    pub username: String,
    pub sessions: i64,
    pub total_hours: f64,
    pub last_session: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DailyTrend {
    pub date: String,
    pub sessions: i64,
    pub hours: f64,
    pub unique_users: i64,
}

#[derive(Serialize, Clone)]
pub struct ProtocolDistribution {
    pub protocol: String,
    pub sessions: i64,
    pub total_hours: f64,
}

#[derive(Serialize, Clone)]
pub struct PeakHour {
    pub hour: i32,
    pub sessions: i64,
}

/// How long the 30-day figures are served before being recomputed.
const STATS_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// Holding the lock while recomputing makes concurrent requests wait for
/// one refresh instead of each running the queries.
static STATS_CACHE: tokio::sync::Mutex<Option<(std::time::Instant, SessionStats)>> =
    tokio::sync::Mutex::const_new(None);

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
    let recording_enabled = crate::services::recordings::get_config(&db.pool)
        .await
        .map(|c| c.enabled)
        .unwrap_or(false);

    let mut cache = STATS_CACHE.lock().await;
    let fresh = cache
        .as_ref()
        .filter(|(at, _)| at.elapsed() < STATS_TTL)
        .map(|(_, stats)| stats.clone());
    let mut stats = match fresh {
        Some(stats) => stats,
        None => {
            let stats = compute_session_stats(&db.pool).await?;
            *cache = Some((std::time::Instant::now(), stats.clone()));
            stats
        }
    };
    drop(cache);
    stats.active_now = active_now;
    stats.recording_enabled = recording_enabled;
    Ok(Json(stats))
}

/// The 30-day figures, all from the recordings table.
async fn compute_session_stats(pool: &sqlx::PgPool) -> Result<SessionStats, AppError> {
    use crate::services::recordings as rec;
    let (
        total_sessions,
        total_hours,
        unique_users,
        avg_duration_mins,
        median_duration_mins,
        total_bandwidth_bytes,
    ) = rec::fetch_session_stats_scalars(pool).await?;
    let daily_trend = rec::fetch_daily_trend(pool).await?;
    let protocol_distribution = rec::fetch_protocol_distribution(pool).await?;
    let peak_hours = rec::fetch_peak_hours(pool).await?;
    let top_connections = rec::fetch_top_connections(pool).await?;
    let top_users = rec::fetch_top_users(pool).await?;

    Ok(SessionStats {
        total_sessions,
        total_hours: (total_hours * 10.0).round() / 10.0,
        unique_users,
        active_now: 0,
        avg_duration_mins: (avg_duration_mins * 10.0).round() / 10.0,
        median_duration_mins: (median_duration_mins * 10.0).round() / 10.0,
        total_bandwidth_bytes,
        recording_enabled: false,
        generated_at: chrono::Utc::now().to_rfc3339(),
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
    })
}

#[derive(Deserialize)]
pub struct ListRecordingsQuery {
    pub user_id: Option<uuid::Uuid>,
    pub connection_id: Option<uuid::Uuid>,
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// List historical recordings with optional filters
pub async fn list_recordings(
    State(state): State<SharedState>,
    Extension(user): Extension<crate::services::middleware::AuthUser>,
    Query(query): Query<ListRecordingsQuery>,
) -> Result<Json<Vec<Recording>>, AppError> {
    crate::services::middleware::check_session_permission(&user)?;
    let db = {
        let s = state.read().await;
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    let recordings = crate::services::recordings::list_admin(
        &db.pool,
        query.user_id,
        query.connection_id,
        query.search,
        query.limit.unwrap_or(50),
        query.offset.unwrap_or(0),
    )
    .await?;

    Ok(Json(recordings))
}

async fn stream_recording_handler(
    socket: axum::extract::ws::WebSocket,
    state: SharedState,
    recording: Recording,
    seek_ms: u64,
    speed: f64,
) {
    if let Err(e) = handle_recording_stream(socket, state, recording, seek_ms, speed).await {
        tracing::error!("Recording stream error: {}", e);
    }
}

pub async fn stream_recording(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(user): Extension<crate::services::middleware::AuthUser>,
    Path(id): Path<uuid::Uuid>,
    Query(query): Query<RecordingStreamQuery>,
) -> Result<impl IntoResponse, AppError> {
    crate::services::middleware::check_session_permission(&user)?;
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
    let recording: Recording = crate::services::recordings::get_by_id(&db.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Recording not found".into()))?;

    let seek_ms = query.seek.unwrap_or(0);
    let speed = query.speed.unwrap_or(1.0).clamp(0.25, 16.0);

    Ok(ws.protocols(["guacamole"]).on_upgrade(move |socket| {
        stream_recording_handler(socket, state, recording, seek_ms, speed)
    }))
}

#[derive(Deserialize)]
pub struct AdminRecordingDownloadQuery {
    pub format: Option<String>,
}

/// GET /api/admin/recordings/:id/download — download a recording for admins.
pub async fn download_recording(
    State(state): State<SharedState>,
    Extension(user): Extension<crate::services::middleware::AuthUser>,
    Path(id): Path<uuid::Uuid>,
    Query(query): Query<AdminRecordingDownloadQuery>,
) -> Result<axum::response::Response, AppError> {
    crate::services::middleware::check_session_permission(&user)?;
    let (db, vault) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).cloned();
        (db, vault)
    };

    let recording: Recording = crate::services::recordings::get_by_id(&db.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Recording not found".into()))?;

    let format = query.format.as_deref().unwrap_or("mp4");
    let (file_path, download_filename, content_type) =
        crate::services::recordings::prepare_recording_for_download(
            &recording,
            format,
            &db.pool,
            vault.as_ref(),
        )
        .await?;

    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| AppError::NotFound(format!("File read error: {e}")))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = axum::body::Body::from_stream(stream);

    let safe_filename = download_filename.replace('"', "");

    Ok(axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{safe_filename}\""),
        )
        .body(body)
        .unwrap())
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

    crate::services::recording_index::ensure(&recording, state.clone());

    // Resume from the nearest checkpoint when the index matches this recording.
    let mut resume = None;
    if seek_ms > 0 {
        if let Some(index) = crate::services::recording_index::load(recording.id).await {
            if let Some(cp) = index.nearest(seek_ms).cloned() {
                if let Ok(prelude) =
                    crate::services::recording_index::read_prelude(recording.id, &cp).await
                {
                    resume = Some((cp, prelude, index.source_len, index.first_ts));
                }
            }
        }
    }
    let (mut reader, prelude, resumed_first_ts) = match resume {
        Some((cp, prelude, source_len, first_ts)) => {
            match open_recording(&state, &recording, cp.offset).await {
                Ok((reader, Some(total))) if total == source_len => {
                    (reader, Some(prelude), first_ts)
                }
                _ => {
                    tracing::info!(recording = %recording.id, "recording index is stale, replaying from the start");
                    (open_recording(&state, &recording, 0).await?.0, None, None)
                }
            }
        }
        None => (open_recording(&state, &recording, 0).await?.0, None, None),
    };

    // Send NVR header with total duration
    let duration_ms = recording.duration_secs.unwrap_or(0) * 1000;
    let duration_str = duration_ms.to_string();
    let header = format_guac_instruction("nvrheader", &[&duration_str]);
    socket
        .send(axum::extract::ws::Message::Text(header.into()))
        .await?;

    let mut parser = GuacamoleParser::new();
    // Instructions waiting to go out as one message. Flushed before every
    // control message and pacing wait so ordering and timing hold.
    let mut outbox = prelude.unwrap_or_default();
    // Never changes once set — for absolute progress; known up front when resuming.
    let mut first_guac_ts: Option<u64> = resumed_first_ts;
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
                                first_guac_ts.get_or_insert(ts);
                                base_guac_ts = Some(ts);
                                base_real_ts = Some(std::time::Instant::now());
                            }
                            (Some(b_ts), Some(b_real)) => {
                                let first_ts = first_guac_ts.unwrap_or(b_ts);
                                let abs_elapsed = ts.saturating_sub(first_ts);

                                // ── Seeking: fast-forward without pacing ──
                                if seeking {
                                    if abs_elapsed >= seek_ms {
                                        flush_outbox(&mut socket, &mut outbox).await?;
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
                                            .send(axum::extract::ws::Message::Text(seeked.into()))
                                            .await?;
                                    } else if last_progress_sent.elapsed().as_millis() > 200 {
                                        flush_outbox(&mut socket, &mut outbox).await?;
                                        let prog = format_guac_instruction(
                                            "nvrprogress",
                                            &[&abs_elapsed.to_string()],
                                        );
                                        let _ = socket
                                            .send(axum::extract::ws::Message::Text(prog.into()))
                                            .await;
                                        last_progress_sent = std::time::Instant::now();
                                    }
                                }

                                if !seeking {
                                    flush_outbox(&mut socket, &mut outbox).await?;
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
                                                    socket.send(axum::extract::ws::Message::Text(prog.into())).await?;
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
                                        socket
                                            .send(axum::extract::ws::Message::Text(prog.into()))
                                            .await?;
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
                outbox.push_str(&instruction.raw);
                if outbox.len() >= OUTBOX_BYTES || (!seeking && instruction.opcode == "sync") {
                    flush_outbox(&mut socket, &mut outbox).await?;
                }
            }
        }
    }
    flush_outbox(&mut socket, &mut outbox).await?;

    // Signal end-of-recording so the frontend can close gracefully
    let end_msg = format_guac_instruction("nvrend", &[]);
    let _ = socket
        .send(axum::extract::ws::Message::Text(end_msg.into()))
        .await;
    let _ = socket.send(axum::extract::ws::Message::Close(None)).await;

    Ok(())
}

/// Batched playback messages are sent once they reach this size.
const OUTBOX_BYTES: usize = 64 * 1024;

type RecordingReader = Box<dyn tokio::io::AsyncRead + Unpin + Send>;

/// Read the recording from byte `from`, with its total length when known.
async fn open_recording(
    state: &SharedState,
    recording: &Recording,
    from: u64,
) -> anyhow::Result<(RecordingReader, Option<u64>)> {
    use tokio::io::AsyncSeekExt;
    if recording.storage_type == "local" {
        let path = std::path::Path::new(crate::services::recording_index::RECORDINGS_DIR)
            .join(&recording.storage_path);
        tracing::info!(
            "Opening local recording: id={}, path={}, from={from}",
            recording.id,
            path.display()
        );
        let mut file = tokio::fs::File::open(&path).await.map_err(|e| {
            tracing::error!(
                "Failed to open recording file: id={}, path={}, err={}",
                recording.id,
                path.display(),
                e
            );
            e
        })?;
        let total = file.metadata().await?.len();
        file.seek(std::io::SeekFrom::Start(from)).await?;
        return Ok((Box::new(tokio::io::BufReader::new(file)), Some(total)));
    }
    let azure = {
        let s = state.read().await;
        let pool =
            s.db.as_ref()
                .ok_or_else(|| anyhow::anyhow!("DB not connected"))?
                .pool
                .clone();
        let vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).cloned();
        crate::services::recordings::get_azure_config(&pool, vault.as_ref())
            .await?
            .ok_or_else(|| anyhow::anyhow!("Azure storage not configured"))?
    };
    let (stream, total) = crate::services::recordings::download_stream_from_azure(
        &azure,
        &recording.storage_path,
        from,
    )
    .await?;
    let reader = tokio_util::io::StreamReader::new(
        stream.map(|res: reqwest::Result<bytes::Bytes>| res.map_err(std::io::Error::other)),
    );
    Ok((Box::new(tokio::io::BufReader::new(reader)), total))
}

/// Send the batched instructions as one message. The client's tunnel
/// parses every instruction in a message, so batches split only between
/// instructions.
async fn flush_outbox(
    socket: &mut axum::extract::ws::WebSocket,
    outbox: &mut String,
) -> Result<(), axum::Error> {
    if outbox.is_empty() {
        return Ok(());
    }
    let text = std::mem::take(outbox);
    socket
        .send(axum::extract::ws::Message::Text(text.into()))
        .await
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

/// Incremental parser over raw bytes. A character split across two reads
/// is decoded once both halves are in, and consumed instructions are
/// released by moving the buffer's start rather than copying the rest.
struct GuacamoleParser {
    buffer: bytes::BytesMut,
}

impl GuacamoleParser {
    fn new() -> Self {
        Self {
            buffer: bytes::BytesMut::new(),
        }
    }

    fn push(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }

    /// The next complete instruction. Malformed input is discarded.
    fn next_instruction(&mut self) -> Option<GuacamoleInstruction> {
        use bytes::Buf;
        let (instruction, consumed) =
            match strata_session::protocol::guacamole::try_parse_instruction(&self.buffer) {
                Ok(Some((parsed, consumed))) => (
                    GuacamoleInstruction {
                        opcode: parsed.opcode.to_owned(),
                        args: parsed.args.iter().map(|a| (*a).to_owned()).collect(),
                        raw: String::from_utf8_lossy(&self.buffer[..consumed]).into_owned(),
                    },
                    consumed,
                ),
                Ok(None) => return None,
                Err(_) => {
                    self.buffer.clear();
                    return None;
                }
            };
        self.buffer.advance(consumed);
        Some(instruction)
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
    fn a_character_split_across_reads_is_not_corrupted() {
        // Reads are 16 KiB; a multi-byte character can straddle two.
        let raw = "4.text,2.中x;3.nop;".as_bytes();
        let split = raw.iter().position(|&b| b >= 0x80).unwrap() + 1;
        let mut parser = GuacamoleParser::new();
        parser.push(&raw[..split]);
        assert!(parser.next_instruction().is_none());
        parser.push(&raw[split..]);
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.args, vec!["中x"]);
        assert_eq!(parser.next_instruction().unwrap().opcode, "nop");
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
    fn a_character_split_across_reads_survives() {
        // "é" is two bytes; a 16 KiB read can end between them.
        let raw = "9.clipboard,4.café;".as_bytes();
        let split = raw.len() - 2;
        let mut parser = GuacamoleParser::new();
        parser.push(&raw[..split]);
        assert!(parser.next_instruction().is_none());
        parser.push(&raw[split..]);
        let inst = parser.next_instruction().unwrap();
        assert_eq!(inst.args, vec!["café"]);
        assert_eq!(inst.raw, "9.clipboard,4.café;");
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
