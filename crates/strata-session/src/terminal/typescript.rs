//! Server-side typescript of a terminal session.
//!
//! Byte-compatible with guacd's, because the point of the feature is that
//! an existing `scriptreplay` or in-house tooling can read the result:
//! a data file bracketed by markers, and a `.timing` sidecar of
//! `<seconds> <bytes>` lines.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt;

/// Written at the head of every data file.
const HEADER: &[u8] = b"[BEGIN TYPESCRIPT]\n";

/// Written at the tail of every data file.
const FOOTER: &[u8] = b"\n[END TYPESCRIPT]\n";

/// Suffix identifying the timing sidecar.
const TIMING_SUFFIX: &str = "timing";

/// Longest gap a single timing entry may claim, in milliseconds.
///
/// A session left open overnight would otherwise record a delay that
/// makes replay unwatchable.
const MAX_DELAY_MS: u128 = 86_400_000;

/// Bytes buffered before a flush, matching guacd so the timing files
/// have comparable granularity.
const BUFFER_BYTES: usize = 4096;

/// An open typescript: raw output plus its timing sidecar.
#[derive(Debug)]
pub struct Typescript {
    data: File,
    timing: File,
    buffer: Vec<u8>,
    last_flush: Instant,
}

impl Typescript {
    /// Create the pair of files under `path`, named after `name`.
    ///
    /// A colliding name is given a numeric suffix rather than being
    /// overwritten: the existing file is somebody's audit trail.
    pub async fn create(path: &Path, name: &str, create_path: bool) -> io::Result<Self> {
        if create_path {
            tokio::fs::create_dir_all(path).await?;
        }

        let (data, data_path) = create_unique(path, name).await?;
        let timing_name = format!(
            "{}.{TIMING_SUFFIX}",
            data_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(name)
        );
        let timing = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(path.join(timing_name))
            .await?;

        let mut typescript = Self {
            data,
            timing,
            buffer: Vec::with_capacity(BUFFER_BYTES),
            last_flush: Instant::now(),
        };
        typescript.data.write_all(HEADER).await?;
        Ok(typescript)
    }

    /// Buffer terminal output, flushing when the buffer is full.
    pub async fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        for chunk in bytes.chunks(BUFFER_BYTES) {
            if self.buffer.len() + chunk.len() > BUFFER_BYTES {
                self.flush().await?;
            }
            self.buffer.extend_from_slice(chunk);
        }
        Ok(())
    }

    /// Write what is buffered, and a timing entry describing it.
    pub async fn flush(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let elapsed = self.last_flush.elapsed().as_millis();
        self.timing
            .write_all(timing_line(elapsed, self.buffer.len()).as_bytes())
            .await?;
        self.data.write_all(&self.buffer).await?;
        self.buffer.clear();
        self.last_flush = Instant::now();
        Ok(())
    }

    /// Flush, close the record and sync both files.
    pub async fn finish(&mut self) -> io::Result<()> {
        self.flush().await?;
        self.data.write_all(FOOTER).await?;
        self.data.flush().await?;
        self.timing.flush().await?;
        self.data.sync_all().await?;
        self.timing.sync_all().await
    }
}

/// One line of the timing sidecar.
///
/// Seconds to six decimal places and a byte count, which is what
/// `scriptreplay` and guacd's own tooling expect.
fn timing_line(elapsed_ms: u128, length: usize) -> String {
    let clamped = elapsed_ms.min(MAX_DELAY_MS);
    // The cast cannot lose precision that matters: the value is clamped
    // to a day in milliseconds.
    let seconds = clamped as f64 / 1000.0;
    format!("{seconds:0.6} {length}\n")
}

/// Open `name` under `path`, adding a numeric suffix if it is taken.
async fn create_unique(path: &Path, name: &str) -> io::Result<(File, PathBuf)> {
    for attempt in 0..=255u16 {
        let candidate = if attempt == 0 {
            path.join(name)
        } else {
            path.join(format!("{name}.{attempt}"))
        };
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate)
            .await
        {
            Ok(file) => return Ok((file, candidate)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "every typescript name in this directory is taken",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The format is guacd's, so existing tooling can read the result.
    #[test]
    fn a_timing_line_is_seconds_to_six_places_and_a_byte_count() {
        assert_eq!(timing_line(0, 0), "0.000000 0\n");
        assert_eq!(timing_line(1, 12), "0.001000 12\n");
        assert_eq!(timing_line(1500, 4096), "1.500000 4096\n");
    }

    /// A session left open overnight would otherwise record a delay that
    /// makes replay unwatchable.
    #[test]
    fn an_absurd_delay_is_clamped_to_a_day() {
        let line = timing_line(u128::MAX, 1);
        assert_eq!(line, "86400.000000 1\n");
    }

    #[tokio::test]
    async fn a_typescript_is_bracketed_by_its_markers() {
        let dir = std::env::temp_dir().join(format!("strata-ts-{}", std::process::id()));
        let mut typescript = Typescript::create(&dir, "session", true)
            .await
            .expect("create");
        typescript.write(b"hello").await.expect("write");
        typescript.finish().await.expect("finish");

        let data = tokio::fs::read(dir.join("session")).await.expect("read");
        assert!(data.starts_with(HEADER), "missing header");
        assert!(data.ends_with(FOOTER), "missing footer");
        assert!(
            String::from_utf8_lossy(&data).contains("hello"),
            "output missing"
        );

        let timing = tokio::fs::read_to_string(dir.join("session.timing"))
            .await
            .expect("read timing");
        let line = timing.lines().next().expect("a timing entry");
        assert!(line.ends_with(" 5"), "byte count wrong: {line}");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// The existing file is somebody's audit trail, so a second session
    /// must not overwrite it.
    #[tokio::test]
    async fn a_second_typescript_does_not_overwrite_the_first() {
        let dir = std::env::temp_dir().join(format!("strata-ts2-{}", std::process::id()));
        let mut first = Typescript::create(&dir, "session", true)
            .await
            .expect("first");
        first.write(b"first").await.expect("write");
        first.finish().await.expect("finish");

        let mut second = Typescript::create(&dir, "session", true)
            .await
            .expect("second");
        second.write(b"second").await.expect("write");
        second.finish().await.expect("finish");

        let original = tokio::fs::read_to_string(dir.join("session"))
            .await
            .expect("read");
        assert!(original.contains("first"), "original was overwritten");
        assert!(dir.join("session.1").exists(), "no suffixed file created");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
