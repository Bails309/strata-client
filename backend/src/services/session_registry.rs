// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! In-memory registry of active tunnel sessions with a per-session ring buffer
//! of Guacamole instructions (NVR mode).  Admins can list active sessions and
//! observe them by replaying the buffer + subscribing to the live broadcast.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

/// Maximum duration of buffered frames per session (5 minutes).
const MAX_BUFFER_DURATION: Duration = Duration::from_secs(300);

/// Maximum total byte size of buffered frames per session (50 MB).
const MAX_BUFFER_BYTES: usize = 50 * 1024 * 1024;

/// Broadcast channel capacity — must be large enough to avoid lagging at
/// typical frame rates (~30–60 fps × multi-instruction batches).
const BROADCAST_CAPACITY: usize = 8192;

// ── Timestamped frame ──────────────────────────────────────────────

struct BufferedFrame {
    timestamp: Instant,
    data: String,
    byte_size: usize,
}

// ── Per-session ring buffer ────────────────────────────────────────

pub struct SessionBuffer {
    frames: VecDeque<BufferedFrame>,
    total_bytes: usize,
    /// Most recent `size` instruction seen (injected at replay start so
    /// the observer's Guacamole client creates the display at the correct
    /// dimensions even when the original instruction has been evicted).
    last_size_instruction: Option<String>,
}

impl SessionBuffer {
    fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            total_bytes: 0,
            last_size_instruction: None,
        }
    }

    /// Append a chunk of Guacamole instructions to the buffer.
    pub fn push(&mut self, data: String) {
        let byte_size = data.len();

        // Cache the most recent `size` instruction so we can inject it on
        // replay even if the original has been evicted from the buffer.
        // A `size` instruction looks like: `4.size,1.0,4.1920,4.1080;`
        if data.contains(".size,") {
            // Extract just the size instruction(s) from the chunk
            for inst in data.split(';') {
                let trimmed = inst.trim();
                if !trimmed.is_empty() && trimmed.contains(".size,") {
                    self.last_size_instruction = Some(format!("{trimmed};"));
                }
            }
        }

        self.frames.push_back(BufferedFrame {
            timestamp: Instant::now(),
            data,
            byte_size,
        });
        self.total_bytes += byte_size;

        // Evict frames older than MAX_BUFFER_DURATION
        let cutoff = Instant::now() - MAX_BUFFER_DURATION;
        while let Some(front) = self.frames.front() {
            if front.timestamp < cutoff {
                self.total_bytes -= front.byte_size;
                self.frames.pop_front();
            } else {
                break;
            }
        }

        // Evict oldest frames if total size exceeds the cap
        while self.total_bytes > MAX_BUFFER_BYTES {
            if let Some(front) = self.frames.pop_front() {
                self.total_bytes -= front.byte_size;
            } else {
                break;
            }
        }
    }

    /// Return all buffered frames from `offset_secs` seconds ago to now.
    pub fn frames_from_offset(&self, offset_secs: u64) -> Vec<String> {
        let cutoff = Instant::now() - Duration::from_secs(offset_secs);
        self.frames
            .iter()
            .filter(|f| f.timestamp >= cutoff)
            .map(|f| f.data.clone())
            .collect()
    }

    /// How many seconds of data the buffer currently holds.
    pub fn buffer_depth_secs(&self) -> u64 {
        match (self.frames.front(), self.frames.back()) {
            (Some(first), Some(last)) => last.timestamp.duration_since(first.timestamp).as_secs(),
            _ => 0,
        }
    }

    /// Cached last `size` instruction, if any.
    pub fn last_size(&self) -> Option<&str> {
        self.last_size_instruction.as_deref()
    }
}

// ── Active session handle ──────────────────────────────────────────

pub struct ActiveSession {
    pub session_id: String,
    pub connection_id: Uuid,
    pub connection_name: String,
    pub protocol: String,
    pub user_id: Uuid,
    pub username: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub buffer: Arc<RwLock<SessionBuffer>>,
    pub broadcast_tx: broadcast::Sender<Arc<String>>,
    /// Bytes received from guacd (server → client direction)
    pub bytes_from_guacd: AtomicU64,
    /// Bytes sent to guacd (client → server direction)
    pub bytes_to_guacd: AtomicU64,
}

// ── Session info (serialisable summary for the admin API) ──────────

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub connection_id: Uuid,
    pub connection_name: String,
    pub protocol: String,
    pub user_id: Uuid,
    pub username: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub buffer_depth_secs: u64,
    pub bytes_from_guacd: u64,
    pub bytes_to_guacd: u64,
}

// ── Registry ───────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, Arc<ActiveSession>>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a new session and return the broadcast sender + buffer
    /// handle for the tunnel proxy to use.
    pub async fn register(
        &self,
        session_id: String,
        connection_id: Uuid,
        connection_name: String,
        protocol: String,
        user_id: Uuid,
        username: String,
    ) -> (broadcast::Sender<Arc<String>>, Arc<RwLock<SessionBuffer>>) {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let buffer = Arc::new(RwLock::new(SessionBuffer::new()));

        let session = Arc::new(ActiveSession {
            session_id: session_id.clone(),
            connection_id,
            connection_name,
            protocol,
            user_id,
            username,
            started_at: chrono::Utc::now(),
            buffer: buffer.clone(),
            broadcast_tx: tx.clone(),
            bytes_from_guacd: AtomicU64::new(0),
            bytes_to_guacd: AtomicU64::new(0),
        });

        self.sessions.write().await.insert(session_id, session);
        (tx, buffer)
    }

    /// Remove a session from the registry (called when the tunnel closes).
    pub async fn unregister(&self, session_id: &str) {
        self.sessions.write().await.remove(session_id);
    }

    /// List all active sessions.
    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        let mut infos = Vec::with_capacity(sessions.len());

        for s in sessions.values() {
            let depth = s.buffer.read().await.buffer_depth_secs();
            infos.push(SessionInfo {
                session_id: s.session_id.clone(),
                connection_id: s.connection_id,
                connection_name: s.connection_name.clone(),
                protocol: s.protocol.clone(),
                user_id: s.user_id,
                username: s.username.clone(),
                started_at: s.started_at,
                buffer_depth_secs: depth,
                bytes_from_guacd: s.bytes_from_guacd.load(Ordering::Relaxed),
                bytes_to_guacd: s.bytes_to_guacd.load(Ordering::Relaxed),
            });
        }
        infos
    }

    /// Look up a single session by ID.
    pub async fn get(&self, session_id: &str) -> Option<Arc<ActiveSession>> {
        self.sessions.read().await.get(session_id).cloned()
    }

    /// Aggregate metrics across all active sessions.
    pub async fn metrics(&self) -> MetricsSummary {
        let sessions = self.sessions.read().await;
        let mut total_bytes_in: u64 = 0;
        let mut total_bytes_out: u64 = 0;
        let mut by_protocol: HashMap<String, u32> = HashMap::new();

        for s in sessions.values() {
            total_bytes_in += s.bytes_from_guacd.load(Ordering::Relaxed);
            total_bytes_out += s.bytes_to_guacd.load(Ordering::Relaxed);
            *by_protocol.entry(s.protocol.clone()).or_insert(0) += 1;
        }

        MetricsSummary {
            active_sessions: sessions.len() as u32,
            total_bytes_from_guacd: total_bytes_in,
            total_bytes_to_guacd: total_bytes_out,
            sessions_by_protocol: by_protocol,
            guacd_pool_size: 0, // placeholder — overridden by admin handler
        }
    }
}

/// Aggregate metrics summary returned by the admin metrics endpoint.
#[derive(Serialize, Clone)]
pub struct MetricsSummary {
    pub active_sessions: u32,
    pub total_bytes_from_guacd: u64,
    pub total_bytes_to_guacd: u64,
    pub sessions_by_protocol: HashMap<String, u32>,
    pub guacd_pool_size: u32,
}
