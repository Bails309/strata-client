// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! In-memory registry of active tunnel sessions with a per-session ring buffer
//! of Guacamole instructions (NVR mode).  Admins can list active sessions and
//! observe them by replaying the buffer + subscribing to the live broadcast.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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

/// Maximum number of concurrent sessions allowed.
const MAX_SESSIONS: usize = 500;

// ── Timestamped frame ──────────────────────────────────────────────

struct BufferedFrame {
    timestamp: Instant,
    data: String,
    byte_size: usize,
}

// ── Credential filtering ───────────────────────────────────────────

/// Filter out Guacamole instructions that could contain credentials.
/// Instructions like `connect` and `args` carry authentication data and
/// must not be stored in the NVR ring buffer.
fn filter_sensitive_instructions(data: &str) -> String {
    // Sensitive instruction opcodes that may carry credentials.
    // We check for the exact opcode using the protocol format "<len>.<opcode>".
    const SENSITIVE_MATCHERS: &[&str] = &["7.connect", "4.args"];

    let mut filtered = String::with_capacity(data.len());
    for inst in data.split_inclusive(';') {
        let trimmed = inst.trim();
        if trimmed.is_empty() {
            continue;
        }
        let is_sensitive = SENSITIVE_MATCHERS.iter().any(|&m| trimmed.starts_with(m));
        if !is_sensitive {
            filtered.push_str(inst);
        }
    }
    filtered
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
    /// Filters out instructions that may contain credentials (connect, args)
    /// to prevent credential leakage through NVR replay.
    pub fn push(&mut self, data: String) {
        // Filter out credential-bearing instructions from the NVR buffer
        let filtered = filter_sensitive_instructions(&data);
        if filtered.is_empty() {
            return;
        }

        let byte_size = filtered.len();

        // Cache the most recent `size` instruction so we can inject it on
        // replay even if the original has been evicted from the buffer.
        // A `size` instruction looks like: `4.size,1.0,4.1920,4.1080;`
        if filtered.contains(".size,") {
            // Extract just the size instruction(s) from the chunk
            for inst in filtered.split(';') {
                let trimmed = inst.trim();
                if !trimmed.is_empty() && trimmed.contains(".size,") {
                    self.last_size_instruction = Some(format!("{trimmed};"));
                }
            }
        }

        self.frames.push_back(BufferedFrame {
            timestamp: Instant::now(),
            data: filtered,
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

    /// Return buffered frames with relative timing (milliseconds since first
    /// frame in the selection).  Used by the observe endpoint to pace replay.
    pub fn frames_with_timing(&self, offset_secs: u64) -> Vec<(u64, String)> {
        let cutoff = Instant::now() - Duration::from_secs(offset_secs);
        let selected: Vec<&BufferedFrame> = self
            .frames
            .iter()
            .filter(|f| f.timestamp >= cutoff)
            .collect();

        let origin = selected.first().map(|f| f.timestamp);
        selected
            .iter()
            .map(|f| {
                let delay = origin
                    .map(|o| f.timestamp.duration_since(o).as_millis() as u64)
                    .unwrap_or(0);
                (delay, f.data.clone())
            })
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
    pub remote_host: String,
    pub client_ip: String,
    pub kill_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
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
    pub remote_host: String,
    pub client_ip: String,
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
    /// Returns `None` if the maximum session limit has been reached.
    #[allow(clippy::too_many_arguments)]
    pub async fn register(
        &self,
        session_id: String,
        connection_id: Uuid,
        connection_name: String,
        protocol: String,
        user_id: Uuid,
        username: String,
        remote_host: String,
        client_ip: String,
    ) -> Option<(
        broadcast::Sender<Arc<String>>,
        Arc<RwLock<SessionBuffer>>,
        tokio::sync::oneshot::Receiver<()>,
    )> {
        // Use a single write lock for atomic check-and-insert (no TOCTOU)
        let mut sessions = self.sessions.write().await;
        if sessions.len() >= MAX_SESSIONS {
            tracing::warn!(
                "Session limit reached ({MAX_SESSIONS}), rejecting new session for user {username}"
            );
            return None;
        }

        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (kill_tx, kill_rx) = tokio::sync::oneshot::channel();
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
            remote_host,
            client_ip,
            kill_tx: Arc::new(tokio::sync::Mutex::new(Some(kill_tx))),
        });

        sessions.insert(session_id, session);
        Some((tx, buffer, kill_rx))
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
                remote_host: s.remote_host.clone(),
                client_ip: s.client_ip.clone(),
            });
        }
        infos
    }

    /// Look up a single session by ID.
    pub async fn get(&self, session_id: &str) -> Option<Arc<ActiveSession>> {
        self.sessions.read().await.get(session_id).cloned()
    }

    /// Forcefully terminate a session by triggering its kill signal.
    pub async fn terminate(&self, session_id: &str) -> bool {
        let session = {
            let sessions = self.sessions.read().await;
            sessions.get(session_id).cloned()
        };

        if let Some(s) = session {
            let mut guard = s.kill_tx.lock().await;
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
                return true;
            }
        }
        false
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
            recommended_per_instance: 20, // placeholder — overridden by admin handler
            system_total_memory: 0,
            system_cpu_cores: 0,
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
    /// Dynamically computed recommended sessions per guacd instance based on
    /// host system resources (CPU + RAM), reserving headroom for other processes.
    pub recommended_per_instance: u32,
    /// Total system memory in bytes (for display).
    pub system_total_memory: u64,
    /// Number of logical CPU cores (for display).
    pub system_cpu_cores: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_removes_connect_instructions() {
        let input = "5.ready,1.0;7.connect,3.rdp,10.myhost.com;4.size,1.0,4.1920,4.1080;";
        let result = filter_sensitive_instructions(input);
        assert!(!result.contains(".connect,"));
        assert!(result.contains(".size,"));
        assert!(result.contains(".ready,"));
    }

    #[test]
    fn filter_removes_args_instructions() {
        let input = "4.args,1.0,8.username,8.password;4.size,1.0,4.1920,4.1080;";
        let result = filter_sensitive_instructions(input);
        assert!(!result.contains(".args,"));
        assert!(result.contains(".size,"));
    }

    #[test]
    fn filter_preserves_normal_instructions() {
        let input = "4.size,1.0,4.1920,4.1080;3.img,1.0,2.12,1.0,1.0,3.100,3.100;";
        let result = filter_sensitive_instructions(input);
        assert_eq!(result, input);
    }

    #[test]
    fn filter_handles_empty_input() {
        assert_eq!(filter_sensitive_instructions(""), "");
    }

    #[test]
    fn session_buffer_evicts_by_size() {
        let mut buf = SessionBuffer::new();
        // Push data exceeding MAX_BUFFER_BYTES
        let large_chunk = "x".repeat(10 * 1024 * 1024); // 10MB
        for _ in 0..6 {
            buf.push(large_chunk.clone());
        }
        // Total should be capped around MAX_BUFFER_BYTES
        assert!(buf.total_bytes <= MAX_BUFFER_BYTES + large_chunk.len());
    }

    #[test]
    fn session_buffer_caches_last_size() {
        let mut buf = SessionBuffer::new();
        buf.push("4.size,1.0,4.1920,4.1080;".to_string());
        assert_eq!(buf.last_size(), Some("4.size,1.0,4.1920,4.1080;"));

        buf.push("3.img,1.0,2.12,1.0,1.0;".to_string());
        // Size should still be cached
        assert_eq!(buf.last_size(), Some("4.size,1.0,4.1920,4.1080;"));
    }

    #[test]
    fn buffer_depth_empty() {
        let buf = SessionBuffer::new();
        assert_eq!(buf.buffer_depth_secs(), 0);
    }

    #[tokio::test]
    async fn registry_register_and_unregister() {
        let registry = SessionRegistry::new();
        let session_id = "test-session-1".to_string();
        let conn_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();

        let result = registry
            .register(
                session_id.clone(),
                conn_id,
                "TestConn".into(),
                "rdp".into(),
                user_id,
                "admin".into(),
                "10.0.0.1".into(),
                "192.168.1.10".into(),
            )
            .await;
        assert!(result.is_some());

        let sessions = registry.list().await;
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "test-session-1");
        assert_eq!(sessions[0].protocol, "rdp");

        registry.unregister(&session_id).await;
        let sessions = registry.list().await;
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn registry_get_session() {
        let registry = SessionRegistry::new();
        let session_id = "test-get-session".to_string();

        registry
            .register(
                session_id.clone(),
                Uuid::new_v4(),
                "Conn".into(),
                "vnc".into(),
                Uuid::new_v4(),
                "user".into(),
                "127.0.0.1".into(),
                "1.2.3.4".into(),
            )
            .await;

        assert!(registry.get(&session_id).await.is_some());
        assert!(registry.get("nonexistent").await.is_none());
    }

    #[test]
    fn filter_only_connect_and_args() {
        let input = "4.sync,1.0;3.nop;7.connect,3.vnc;4.args,2.10,3.foo;3.end;";
        let result = filter_sensitive_instructions(input);
        assert!(result.contains("sync"));
        assert!(result.contains("nop"));
        assert!(result.contains("end"));
        assert!(!result.contains("connect"));
        assert!(!result.contains("args"));
    }

    #[test]
    fn session_buffer_push_filtered_out_entirely() {
        let mut buf = SessionBuffer::new();
        // Only sensitive instructions — should result in nothing buffered
        buf.push("7.connect,3.rdp,10.myhost.com;".into());
        assert_eq!(buf.frames.len(), 0);
        assert_eq!(buf.total_bytes, 0);
    }

    #[test]
    fn session_info_serializes() {
        let info = SessionInfo {
            session_id: "s1".into(),
            connection_id: Uuid::new_v4(),
            connection_name: "conn".into(),
            protocol: "rdp".into(),
            user_id: Uuid::new_v4(),
            username: "admin".into(),
            started_at: chrono::Utc::now(),
            buffer_depth_secs: 120,
            bytes_from_guacd: 5000,
            bytes_to_guacd: 2000,
            remote_host: "target".into(),
            client_ip: "source".into(),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["protocol"], "rdp");
        assert_eq!(json["buffer_depth_secs"], 120);
        assert_eq!(json["bytes_from_guacd"], 5000);
    }

    #[test]
    fn metrics_summary_serializes() {
        let m = MetricsSummary {
            active_sessions: 3,
            total_bytes_from_guacd: 1024,
            total_bytes_to_guacd: 512,
            sessions_by_protocol: {
                let mut map = HashMap::new();
                map.insert("rdp".into(), 2);
                map.insert("vnc".into(), 1);
                map
            },
            guacd_pool_size: 5,
            recommended_per_instance: 20,
            system_total_memory: 0,
            system_cpu_cores: 0,
        };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["active_sessions"], 3);
        assert_eq!(json["guacd_pool_size"], 5);
    }

    #[test]
    fn constants_are_sensible() {
        assert_eq!(MAX_BUFFER_DURATION, Duration::from_secs(300));
        assert_eq!(MAX_BUFFER_BYTES, 50 * 1024 * 1024);
        assert_eq!(BROADCAST_CAPACITY, 8192);
        assert_eq!(MAX_SESSIONS, 500);
    }

    #[tokio::test]
    async fn registry_metrics_empty() {
        let registry = SessionRegistry::new();
        let m = registry.metrics().await;
        assert_eq!(m.active_sessions, 0);
        assert_eq!(m.total_bytes_from_guacd, 0);
        assert_eq!(m.total_bytes_to_guacd, 0);
        assert!(m.sessions_by_protocol.is_empty());
    }

    #[tokio::test]
    async fn registry_metrics_with_sessions() {
        let registry = SessionRegistry::new();
        registry
            .register(
                "m1".into(),
                Uuid::new_v4(),
                "C1".into(),
                "rdp".into(),
                Uuid::new_v4(),
                "u1".into(),
                "10.0.0.1".into(),
                "1.1.1.1".into(),
            )
            .await;
        registry
            .register(
                "m2".into(),
                Uuid::new_v4(),
                "C2".into(),
                "vnc".into(),
                Uuid::new_v4(),
                "u2".into(),
                "10.0.0.2".into(),
                "2.2.2.2".into(),
            )
            .await;
        let m = registry.metrics().await;
        assert_eq!(m.active_sessions, 2);
        assert_eq!(*m.sessions_by_protocol.get("rdp").unwrap(), 1);
        assert_eq!(*m.sessions_by_protocol.get("vnc").unwrap(), 1);
    }

    #[test]
    fn session_buffer_updates_last_size() {
        let mut buf = SessionBuffer::new();
        buf.push("4.size,1.0,4.1920,4.1080;".into());
        assert_eq!(buf.last_size(), Some("4.size,1.0,4.1920,4.1080;"));
        buf.push("4.size,1.0,4.2560,4.1440;".into());
        assert_eq!(buf.last_size(), Some("4.size,1.0,4.2560,4.1440;"));
    }

    #[tokio::test]
    async fn registry_terminate_session() {
        let registry = SessionRegistry::new();
        let result = registry
            .register(
                "kill-me".into(),
                Uuid::new_v4(),
                "Conn".into(),
                "rdp".into(),
                Uuid::new_v4(),
                "user".into(),
                "10.0.0.1".into(),
                "1.1.1.1".into(),
            )
            .await;
        assert!(result.is_some());

        // Terminate should succeed the first time
        assert!(registry.terminate("kill-me").await);
        // Second call returns false (kill_tx already consumed)
        assert!(!registry.terminate("kill-me").await);
        // Nonexistent session returns false
        assert!(!registry.terminate("no-such").await);
    }

    // ── filter_sensitive_instructions extended ──────────────────────

    #[test]
    fn filter_preserves_size_instruction() {
        let input = "4.size,1.0,4.1920,4.1080;";
        let result = filter_sensitive_instructions(input);
        assert_eq!(result, input);
    }

    #[test]
    fn filter_preserves_img_instruction() {
        let input = "3.img,1.0,2.12,1.0,1.0,3.100,3.100;";
        let result = filter_sensitive_instructions(input);
        assert_eq!(result, input);
    }

    #[test]
    fn filter_preserves_sync_instruction() {
        let input = "4.sync,1.0;";
        let result = filter_sensitive_instructions(input);
        assert_eq!(result, input);
    }

    #[test]
    fn filter_removes_connect_but_keeps_rest() {
        let input = "4.size,1.0,4.1920,4.1080;7.connect,3.rdp;3.nop;";
        let result = filter_sensitive_instructions(input);
        assert!(result.contains("size"));
        assert!(result.contains("nop"));
        assert!(!result.contains("connect"));
    }

    #[test]
    fn filter_only_sensitive_removed() {
        let input = "4.args,8.hostname;4.sync,1.0;7.connect,3.rdp;3.img,1.0;";
        let result = filter_sensitive_instructions(input);
        assert!(!result.contains("args"));
        assert!(!result.contains("connect"));
        assert!(result.contains("sync"));
        assert!(result.contains("img"));
    }

    // ── SessionBuffer extended ─────────────────────────────────────

    #[test]
    fn session_buffer_new_empty() {
        let buf = SessionBuffer::new();
        assert_eq!(buf.total_bytes, 0);
        assert_eq!(buf.frames.len(), 0);
        assert!(buf.last_size().is_none());
        assert_eq!(buf.buffer_depth_secs(), 0);
    }

    #[test]
    fn session_buffer_push_increments_bytes() {
        let mut buf = SessionBuffer::new();
        buf.push("4.size,1.0,4.1920,4.1080;".into());
        assert!(buf.total_bytes > 0);
        assert_eq!(buf.frames.len(), 1);
    }

    #[test]
    fn session_buffer_filtered_out_does_not_add_frames() {
        let mut buf = SessionBuffer::new();
        buf.push("7.connect,3.rdp;".into());
        assert_eq!(buf.frames.len(), 0);
        assert_eq!(buf.total_bytes, 0);
    }

    #[test]
    fn session_buffer_multiple_pushes() {
        let mut buf = SessionBuffer::new();
        buf.push("4.size,1.0,4.1920,4.1080;".into());
        buf.push("3.img,1.0,2.12;".into());
        buf.push("4.sync,1.0;".into());
        assert_eq!(buf.frames.len(), 3);
    }

    #[test]
    fn session_buffer_frames_with_timing_empty() {
        let buf = SessionBuffer::new();
        let frames = buf.frames_with_timing(300);
        assert!(frames.is_empty());
    }

    #[test]
    fn session_buffer_frames_with_timing_has_data() {
        let mut buf = SessionBuffer::new();
        buf.push("4.size,1.0,4.1920,4.1080;".into());
        buf.push("3.nop;".into());
        let frames = buf.frames_with_timing(300);
        assert_eq!(frames.len(), 2);
        // First frame should have 0 delay
        assert_eq!(frames[0].0, 0);
    }

    #[test]
    fn session_buffer_size_instruction_caching() {
        let mut buf = SessionBuffer::new();
        assert!(buf.last_size().is_none());

        buf.push("3.nop;".into());
        assert!(buf.last_size().is_none());

        buf.push("4.size,1.0,3.800,3.600;".into());
        assert_eq!(buf.last_size(), Some("4.size,1.0,3.800,3.600;"));

        // Update with new size
        buf.push("4.size,1.0,4.1024,3.768;".into());
        assert_eq!(buf.last_size(), Some("4.size,1.0,4.1024,3.768;"));

        // Non-size push doesn't change it
        buf.push("3.img,1.0;".into());
        assert_eq!(buf.last_size(), Some("4.size,1.0,4.1024,3.768;"));
    }

    #[tokio::test]
    async fn registry_max_sessions_enforcement() {
        let registry = SessionRegistry::new();
        // Register MAX_SESSIONS sessions
        for i in 0..MAX_SESSIONS {
            registry
                .register(
                    format!("session-{i}"),
                    Uuid::new_v4(),
                    "Conn".into(),
                    "rdp".into(),
                    Uuid::new_v4(),
                    "user".into(),
                    "10.0.0.1".into(),
                    "1.1.1.1".into(),
                )
                .await;
        }
        let sessions = registry.list().await;
        assert_eq!(sessions.len(), MAX_SESSIONS);

        // Next registration should be rejected
        let result = registry
            .register(
                "session-overflow".into(),
                Uuid::new_v4(),
                "Conn".into(),
                "rdp".into(),
                Uuid::new_v4(),
                "user".into(),
                "10.0.0.1".into(),
                "1.1.1.1".into(),
            )
            .await;
        assert!(result.is_none());
    }
}
