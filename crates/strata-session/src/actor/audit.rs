//! Append-only audit sink.
//!
//! Replaces `guaclog`. Instead of shelling out to a separate C tool that
//! re-reads a recording after the fact, the session actor taps its own
//! frame stream and writes timestamped records as the session runs, so a
//! session that is killed mid-flight is still recorded up to the moment
//! it died.

use async_trait::async_trait;
use bytes::{BufMut, BytesMut};
use std::path::{Path, PathBuf};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::error::SessionError;
use crate::transport::ClientFrame;

/// One durably recorded event.
#[derive(Debug, Clone)]
pub struct AuditRecord {
    /// Monotonic sequence number within the session.
    pub seq: u64,
    /// Wall-clock time in milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    /// The frame as the client saw it.
    pub frame: ClientFrame,
}

impl AuditRecord {
    /// Serialise as a length-prefixed record:
    /// `[u64 seq][u64 timestamp][u8 kind][u32 len][payload]`.
    #[must_use]
    pub fn encode(&self) -> BytesMut {
        let payload = self.frame.payload();
        let mut out = BytesMut::with_capacity(21 + payload.len());
        out.put_u64(self.seq);
        out.put_u64(self.timestamp_ms);
        out.put_u8(match self.frame {
            ClientFrame::Text(_) => 0,
            ClientFrame::Binary(_) => 1,
        });
        out.put_u32(payload.len() as u32);
        out.put_slice(payload);
        out
    }
}

/// Somewhere session records are durably written.
#[async_trait]
pub trait AuditSink: Send + 'static {
    /// Record one event.
    async fn record(&mut self, record: AuditRecord) -> Result<(), SessionError>;

    /// Make everything recorded so far durable. Called once per sync
    /// interval, so it bounds what a crash can lose.
    async fn checkpoint(&mut self) -> Result<(), SessionError> {
        Ok(())
    }

    /// Flush and close. Called exactly once during orderly teardown.
    async fn finalize(&mut self) -> Result<(), SessionError>;
}

/// Discards everything. For sessions with recording disabled by policy.
#[derive(Debug, Default)]
pub struct NullAuditSink;

#[async_trait]
impl AuditSink for NullAuditSink {
    async fn record(&mut self, _record: AuditRecord) -> Result<(), SessionError> {
        Ok(())
    }

    async fn finalize(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
}

/// Buffered append-only file sink.
#[derive(Debug)]
pub struct FileAuditSink {
    path: PathBuf,
    writer: BufWriter<File>,
    records: u64,
}

impl FileAuditSink {
    /// Create (or append to) the recording at `path`.
    pub async fn create(path: impl AsRef<Path>) -> Result<Self, SessionError> {
        let path = path.as_ref().to_path_buf();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|e| SessionError::Audit(format!("open {}: {e}", path.display())))?;
        Ok(Self {
            path,
            writer: BufWriter::new(file),
            records: 0,
        })
    }

    /// Number of records written so far.
    #[must_use]
    pub fn records_written(&self) -> u64 {
        self.records
    }
}

#[async_trait]
impl AuditSink for FileAuditSink {
    async fn record(&mut self, record: AuditRecord) -> Result<(), SessionError> {
        let encoded = record.encode();
        self.writer
            .write_all(&encoded)
            .await
            .map_err(|e| SessionError::Audit(format!("write {}: {e}", self.path.display())))?;
        self.records += 1;
        Ok(())
    }

    async fn checkpoint(&mut self) -> Result<(), SessionError> {
        sync_writer(&mut self.writer, &self.path, false).await
    }

    async fn finalize(&mut self) -> Result<(), SessionError> {
        sync_writer(&mut self.writer, &self.path, true).await
    }
}

/// Append-only `.guac` recording.
///
/// Writes the raw Guacamole instruction stream and nothing else, which
/// is exactly what `guacd` produces for its `recording-path` parameter.
/// Keeping the format byte-compatible means the existing playback route,
/// `guacenc` and the MP4 conversion path all work against a natively
/// served session without knowing one exists.
#[derive(Debug)]
pub struct GuacRecordingSink {
    path: PathBuf,
    writer: BufWriter<File>,
    bytes: u64,
}

impl GuacRecordingSink {
    /// Create the recording at `path`, creating parent directories.
    pub async fn create(path: impl AsRef<Path>) -> Result<Self, SessionError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| SessionError::Audit(format!("create {}: {e}", parent.display())))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|e| SessionError::Audit(format!("open {}: {e}", path.display())))?;
        Ok(Self {
            path,
            writer: BufWriter::new(file),
            bytes: 0,
        })
    }

    /// Instruction bytes written so far.
    #[must_use]
    pub fn bytes_written(&self) -> u64 {
        self.bytes
    }
}

#[async_trait]
impl AuditSink for GuacRecordingSink {
    async fn record(&mut self, record: AuditRecord) -> Result<(), SessionError> {
        // Binary media envelopes are not Guacamole instructions; writing
        // them would corrupt the recording for every existing reader.
        let ClientFrame::Text(bytes) = &record.frame else {
            return Ok(());
        };
        self.writer
            .write_all(bytes)
            .await
            .map_err(|e| SessionError::Audit(format!("write {}: {e}", self.path.display())))?;
        self.bytes += bytes.len() as u64;
        Ok(())
    }

    async fn checkpoint(&mut self) -> Result<(), SessionError> {
        sync_writer(&mut self.writer, &self.path, false).await
    }

    async fn finalize(&mut self) -> Result<(), SessionError> {
        sync_writer(&mut self.writer, &self.path, true).await
    }
}

/// Flush buffered bytes to the file and sync them to disk; `all` also
/// syncs metadata, for the final close.
async fn sync_writer(
    writer: &mut BufWriter<File>,
    path: &Path,
    all: bool,
) -> Result<(), SessionError> {
    writer
        .flush()
        .await
        .map_err(|e| SessionError::Audit(format!("flush {}: {e}", path.display())))?;
    let file = writer.get_mut();
    let synced = if all {
        file.sync_all().await
    } else {
        file.sync_data().await
    };
    synced.map_err(|e| SessionError::Audit(format!("fsync {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    #[test]
    fn records_are_length_prefixed_and_self_describing() {
        let record = AuditRecord {
            seq: 3,
            timestamp_ms: 1_726_000_000_000,
            frame: ClientFrame::Text(Bytes::from_static(b"3.nop;")),
        };
        let encoded = record.encode();
        assert_eq!(u64::from_be_bytes(encoded[0..8].try_into().unwrap()), 3);
        assert_eq!(
            u64::from_be_bytes(encoded[8..16].try_into().unwrap()),
            1_726_000_000_000
        );
        assert_eq!(encoded[16], 0);
        assert_eq!(u32::from_be_bytes(encoded[17..21].try_into().unwrap()), 6);
        assert_eq!(&encoded[21..], b"3.nop;");
    }

    #[tokio::test]
    async fn file_sink_appends_and_flushes() {
        let dir = std::env::temp_dir().join(format!("strata-audit-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("session.rec");

        let mut sink = FileAuditSink::create(&path).await.unwrap();
        for seq in 0..3u64 {
            sink.record(AuditRecord {
                seq,
                timestamp_ms: seq,
                frame: ClientFrame::Binary(Bytes::from_static(b"\xAA")),
            })
            .await
            .unwrap();
        }
        assert_eq!(sink.records_written(), 3);
        sink.finalize().await.unwrap();

        let written = tokio::fs::read(&path).await.unwrap();
        assert_eq!(written.len(), 3 * 22);
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn guac_recording_is_a_raw_instruction_stream() {
        let dir = std::env::temp_dir().join(format!("strata-guac-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("session.guac");

        let mut sink = GuacRecordingSink::create(&path).await.unwrap();
        for (seq, text) in [b"4.size,1.0,4.1024,3.768;".as_slice(), b"3.nop;"]
            .into_iter()
            .enumerate()
        {
            sink.record(AuditRecord {
                seq: seq as u64,
                timestamp_ms: 0,
                frame: ClientFrame::Text(Bytes::copy_from_slice(text)),
            })
            .await
            .unwrap();
        }
        sink.finalize().await.unwrap();

        // Byte-for-byte what guacd would have written: no framing, no
        // timestamps, just the instructions.
        let written = tokio::fs::read(&path).await.unwrap();
        assert_eq!(written, b"4.size,1.0,4.1024,3.768;3.nop;");
        assert_eq!(sink.bytes_written(), written.len() as u64);

        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn guac_recording_never_contains_binary_envelopes() {
        let dir = std::env::temp_dir().join(format!("strata-guac-{}", uuid::Uuid::new_v4()));
        let path = dir.join("session.guac");

        let mut sink = GuacRecordingSink::create(&path).await.unwrap();
        sink.record(AuditRecord {
            seq: 0,
            timestamp_ms: 0,
            frame: ClientFrame::Binary(Bytes::from_static(b"\xAA\x01binary")),
        })
        .await
        .unwrap();
        sink.record(AuditRecord {
            seq: 1,
            timestamp_ms: 0,
            frame: ClientFrame::Text(Bytes::from_static(b"3.nop;")),
        })
        .await
        .unwrap();
        sink.finalize().await.unwrap();

        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"3.nop;");
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}
