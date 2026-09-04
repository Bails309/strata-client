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

    async fn finalize(&mut self) -> Result<(), SessionError> {
        self.writer
            .flush()
            .await
            .map_err(|e| SessionError::Audit(format!("flush {}: {e}", self.path.display())))?;
        self.writer
            .get_mut()
            .sync_all()
            .await
            .map_err(|e| SessionError::Audit(format!("fsync {}: {e}", self.path.display())))?;
        Ok(())
    }
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
}
