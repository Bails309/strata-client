// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Antivirus scanning trait + pluggable backends.
//!
//! Two upload paths in the codebase produce a temp file on disk:
//!
//! 1. [`crate::routes::files::upload`] — in-session Quick Share (inbound).
//! 2. [`crate::routes::outbound_shares::parse_outbound_multipart`] — the
//!    approval-gated outbound Quick Share.
//!
//! Both call [`Scanner::scan`] with the temp path right after the
//! multipart stream completes. The verdict is one of:
//!
//! - [`Verdict::Clean`]    — file passed; carry on.
//! - [`Verdict::Infected`] — engine signature matched; the caller
//!   deletes the temp file, writes an audit event, and returns a
//!   `Validation` error to the user with the signature name in the
//!   message so the SPA / approver UI can surface it verbatim.
//! - [`Verdict::Skipped`]  — engine deliberately did not scan
//!   (oversize, type filter). Treated as **allowed**: scanning is
//!   defence-in-depth and we don't want a 5 GB file to silently fail
//!   uploads when the operator explicitly capped `max_scan_size`.
//! - [`Verdict::Error`]    — engine non-deterministic failure
//!   (daemon unreachable, transport error, malformed response).
//!   The caller consults [`Config::fail_mode`] to decide whether to
//!   block (`block`, recommended) or pass through (`allow`).
//!
//! ## Backends
//!
//! - [`OffScanner`]     — no-op. Always returns
//!   `Skipped { reason: "scanning disabled" }`. The default.
//! - [`ClamAvScanner`]  — talks to `clamd` over TCP using the
//!   `INSTREAM` command. Bundled sidecar pattern; see the `clamav`
//!   service in `docker-compose.yml`.
//! - [`CommandScanner`] — shells out to an admin-supplied binary
//!   (`STRATA_AV_COMMAND=/usr/local/bin/scan {path}`). Exit code 0
//!   = clean, 1 = infected (last stdout line is the signature),
//!   any other code = error. The escape hatch for shops with
//!   Microsoft Defender for Endpoint (`mdatp scan custom`),
//!   CrowdStrike Falcon, Sophos, etc. — same engine, same
//!   signatures, with the application getting an actionable
//!   verdict instead of an opaque quarantine.
//!
//! ## Configuration (all env-driven)
//!
//! | Variable                       | Default              | Meaning |
//! |--------------------------------|----------------------|---------|
//! | `STRATA_AV_BACKEND`            | `off`                | `off`, `clamav`, `command` |
//! | `STRATA_AV_CLAMD_ADDR`         | `clamav:3310`        | `host:port` of `clamd` |
//! | `STRATA_AV_COMMAND`            | (none)               | e.g. `/usr/local/bin/scan` |
//! | `STRATA_AV_FAIL_MODE`          | `block`              | `block` or `allow` on `Error` |
//! | `STRATA_AV_MAX_SCAN_SIZE`      | `524288000` (500 MB) | bytes; files larger → `Skipped`. Matches the 500 MB upload cap so every accepted upload is scanned. |
//! | `STRATA_AV_TIMEOUT_MS`         | `120000` (2 min)     | per-scan wall-clock cap. 500 MB nested archives can comfortably exceed 30 s. |

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Default `clamd` TCP endpoint (matches the bundled compose sidecar).
const DEFAULT_CLAMD_ADDR: &str = "clamav:3310";
/// Default per-scan wall-clock cap (milliseconds). 500 MB nested
/// archives can comfortably exceed 30 s on modest hardware, so the
/// default is set well clear of that ceiling.
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// Default upper bound on files to scan (bytes). Anything larger is
/// reported as [`Verdict::Skipped`] with `reason = "oversize"`.
/// Set to 500 MB to match
/// [`crate::services::file_store::MAX_FILE_SIZE`] — so every upload
/// the backend accepts is also scanned, with no silent
/// large-file bypass.
const DEFAULT_MAX_SCAN_SIZE: u64 = 500 * 1024 * 1024;
/// Chunk size used when streaming a file into clamd INSTREAM.
const INSTREAM_CHUNK_SIZE: usize = 64 * 1024;
/// Hard ceiling clamd will accept for a single INSTREAM chunk (16 MB).
/// We stay well below it; this constant exists to document the protocol.
#[allow(dead_code)]
const CLAMD_INSTREAM_MAX_CHUNK: usize = 16 * 1024 * 1024;

/// Stringly-typed verdict returned by [`Scanner::scan`]. The wire
/// representation (lowercase tags) matches the `av_scan_status`
/// column added by migration 078 and the JSON surfaced to the
/// approver UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "status")]
pub enum Verdict {
    /// File passed the scan.
    Clean,
    /// Engine signature matched. `signature` is the human-readable
    /// detection name (e.g. `Win.Test.EICAR_HDB-1`); surfaced to the
    /// user in the rejection message and persisted for audit.
    Infected { signature: String },
    /// Engine deliberately did not scan. Treated as allowed. Common
    /// reasons: `"oversize"`, `"scanning disabled"`.
    Skipped { reason: String },
    /// Engine non-deterministic failure. `message` is the underlying
    /// error string for logs; whether the upload is accepted is
    /// governed by [`Config::fail_mode`].
    Error { message: String },
}

impl Verdict {
    /// Lowercase tag matching the `av_scan_status` column vocabulary.
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Clean => "clean",
            Verdict::Infected { .. } => "infected",
            Verdict::Skipped { .. } => "skipped",
            Verdict::Error { .. } => "error",
        }
    }

    /// Detection name if any (only present on `Infected`).
    pub fn signature(&self) -> Option<&str> {
        match self {
            Verdict::Infected { signature } => Some(signature),
            _ => None,
        }
    }

    /// Human-readable diagnostic accompanying the verdict, if any:
    /// the engine-supplied error string for [`Verdict::Error`] (e.g.
    /// `"INSTREAM size limit exceeded. ERROR"`) or the skip reason
    /// for [`Verdict::Skipped`] (e.g. `"oversize"`). Used by the
    /// route handlers so log lines surface *why* a scan failed
    /// without an operator having to re-run the request with
    /// response-body capture.
    pub fn message(&self) -> Option<&str> {
        match self {
            Verdict::Error { message } => Some(message),
            Verdict::Skipped { reason } => Some(reason),
            Verdict::Clean | Verdict::Infected { .. } => None,
        }
    }

    /// Whether this verdict should *block* the upload, taking
    /// `fail_mode` into account for `Error` verdicts.
    pub fn blocks(&self, fail_mode: FailMode) -> bool {
        match self {
            Verdict::Infected { .. } => true,
            Verdict::Error { .. } => fail_mode == FailMode::Block,
            Verdict::Clean | Verdict::Skipped { .. } => false,
        }
    }

    /// User-facing rejection message used by the route handlers when
    /// [`Self::blocks`] returns `true`. Maps the raw engine output to
    /// an actionable hint:
    ///
    /// - `Infected` → names the signature so the user knows *what*
    ///   was detected.
    /// - `Error` with a `"exceeded N ms"` / `"time limit reached"`
    ///   message → tells the user the scan **timed out** and that
    ///   deeply-nested archives (Java WAR/JAR/EAR, large MSIs, ISOs
    ///   with embedded archives) are the usual culprit, plus a
    ///   suggestion to try a smaller or pre-extracted file. This is
    ///   the path triggered by the well-known clamd vs WAR-archive
    ///   pathology — the 120 s `Global time limit` collides with
    ///   the backend `STRATA_AV_TIMEOUT_MS` and the user only sees
    ///   a bare HTTP 400.
    /// - `Error` with `"Connection refused"` / `"transport error"` /
    ///   `"connection reset"` → tells the user the AV daemon was
    ///   unreachable and to retry (clamd container restarting, OOM,
    ///   or still loading signatures on first boot).
    /// - Any other `Error` → preserves the raw engine message so
    ///   operators reading the user's screenshot can still debug.
    ///
    /// `Clean` / `Skipped` never reach this method (they do not
    /// block); calling on those variants returns a generic string
    /// rather than panicking, so callers stay infallible.
    pub fn user_facing_block_message(&self) -> String {
        match self {
            Verdict::Infected { signature } => {
                format!("File rejected by malware scan: {signature}")
            }
            Verdict::Error { message } => {
                let lc = message.to_ascii_lowercase();
                if lc.contains("exceeded")
                    || lc.contains("time limit")
                    || lc.contains("timed out")
                    || lc.contains("timeout")
                {
                    "Antivirus scan timed out before it could finish. This usually \
                     happens with Java WAR/JAR/EAR archives or other files \
                     containing many nested or deeply-compressed entries — they \
                     are extremely expensive for the scanner to walk. Please \
                     try a smaller file, or pre-extract the archive and upload \
                     the contents individually."
                        .into()
                } else if lc.contains("connection refused")
                    || lc.contains("transport error")
                    || lc.contains("connection reset")
                    || lc.contains("broken pipe")
                {
                    "The antivirus scanner is temporarily unavailable. Please \
                     wait a moment and try again. If this persists, contact \
                     your administrator."
                        .into()
                } else {
                    format!("Antivirus scan failed: {message}")
                }
            }
            Verdict::Clean | Verdict::Skipped { .. } => {
                // Defensive: blocks() returns false for these variants so
                // the route handlers never reach this arm. Return a
                // generic non-empty string rather than panicking so a
                // future caller can't crash the worker by accident.
                "Upload rejected.".into()
            }
        }
    }
}

/// What to do when the scanner reports an [`Verdict::Error`]
/// (daemon down, transport failure, malformed response).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailMode {
    /// Refuse the upload — safer default. Recommended for production.
    Block,
    /// Accept the upload and record `av_scan_status = error` for
    /// later forensic review. Use only when scanner availability is
    /// known to be lossy and the operator accepts the risk.
    Allow,
}

impl FailMode {
    fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "allow" | "pass" | "open" => FailMode::Allow,
            _ => FailMode::Block,
        }
    }
}

/// Static configuration read from process environment at boot.
#[derive(Debug, Clone)]
pub struct Config {
    pub backend: Backend,
    pub fail_mode: FailMode,
    pub max_scan_size: u64,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub enum Backend {
    /// Disabled — every scan returns `Skipped { reason: "scanning disabled" }`.
    Off,
    /// `clamd` TCP endpoint, `host:port`.
    ClamAv { addr: String },
    /// Shell-out to an admin-supplied scanner binary. The placeholder
    /// `{path}` (if present in `command`) is replaced with the temp
    /// file path; otherwise the path is appended as the final argv.
    Command { command: String },
}

impl Config {
    /// Read `STRATA_AV_*` from the process environment. Never panics
    /// on bad input — invalid values fall back to safe defaults and
    /// are logged at WARN.
    pub fn from_env() -> Self {
        let backend = match std::env::var("STRATA_AV_BACKEND")
            .unwrap_or_else(|_| "off".into())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "clamav" | "clamd" => {
                let addr = std::env::var("STRATA_AV_CLAMD_ADDR")
                    .unwrap_or_else(|_| DEFAULT_CLAMD_ADDR.into());
                Backend::ClamAv { addr }
            }
            "command" | "cmd" | "exec" => match std::env::var("STRATA_AV_COMMAND") {
                Ok(cmd) if !cmd.trim().is_empty() => Backend::Command { command: cmd },
                _ => {
                    tracing::warn!(
                        "STRATA_AV_BACKEND=command but STRATA_AV_COMMAND is empty; \
                         disabling AV scanning"
                    );
                    Backend::Off
                }
            },
            "off" | "disabled" | "none" | "" => Backend::Off,
            other => {
                tracing::warn!(
                    backend = %other,
                    "Unknown STRATA_AV_BACKEND value; disabling AV scanning"
                );
                Backend::Off
            }
        };

        let fail_mode = FailMode::from_str(
            &std::env::var("STRATA_AV_FAIL_MODE").unwrap_or_else(|_| "block".into()),
        );

        let max_scan_size = std::env::var("STRATA_AV_MAX_SCAN_SIZE")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_MAX_SCAN_SIZE);

        let timeout_ms = std::env::var("STRATA_AV_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_TIMEOUT_MS);

        Self {
            backend,
            fail_mode,
            max_scan_size,
            timeout: Duration::from_millis(timeout_ms),
        }
    }
}

/// Trait implemented by every concrete scanner backend.
///
/// Implementations must be `Send + Sync` because the scanner is stored
/// in [`crate::services::app_state::AppState`] as
/// `Arc<dyn Scanner>` and called from many request tasks concurrently.
#[async_trait::async_trait]
pub trait Scanner: Send + Sync + std::fmt::Debug {
    /// Scan the file at `path` and return a [`Verdict`].
    ///
    /// Implementations MUST honour `max_scan_size`: if the file is
    /// larger they MUST return `Verdict::Skipped { reason: "oversize" }`
    /// instead of attempting the scan.
    async fn scan(&self, path: &Path) -> Verdict;

    /// Backend tag for logging / DB persistence
    /// (`off`, `clamav`, `command`).
    fn backend_tag(&self) -> &'static str;
}

// ── Off backend ────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct OffScanner;

#[async_trait::async_trait]
impl Scanner for OffScanner {
    async fn scan(&self, _path: &Path) -> Verdict {
        Verdict::Skipped {
            reason: "scanning disabled".into(),
        }
    }
    fn backend_tag(&self) -> &'static str {
        "off"
    }
}

// ── ClamAV backend ─────────────────────────────────────────────────

/// `clamd` INSTREAM client. Each call dials a fresh TCP connection;
/// `clamd` is single-shot per command and pooling buys little for the
/// upload throughput we care about.
#[derive(Debug, Clone)]
pub struct ClamAvScanner {
    pub addr: String,
    pub max_scan_size: u64,
    pub timeout: Duration,
}

impl ClamAvScanner {
    pub fn new(addr: String, max_scan_size: u64, timeout: Duration) -> Self {
        Self {
            addr,
            max_scan_size,
            timeout,
        }
    }
}

#[async_trait::async_trait]
impl Scanner for ClamAvScanner {
    async fn scan(&self, path: &Path) -> Verdict {
        // Cheap pre-check: oversize → Skipped without a network round trip.
        match tokio::fs::metadata(path).await {
            Ok(md) if md.len() > self.max_scan_size => {
                return Verdict::Skipped {
                    reason: "oversize".into(),
                };
            }
            Ok(_) => {}
            Err(e) => {
                return Verdict::Error {
                    message: format!("stat failed: {e}"),
                };
            }
        }

        match tokio::time::timeout(self.timeout, clamd_instream(&self.addr, path)).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => Verdict::Error {
                message: format!("clamd transport error: {e}"),
            },
            Err(_) => Verdict::Error {
                message: format!("clamd scan exceeded {} ms", self.timeout.as_millis()),
            },
        }
    }
    fn backend_tag(&self) -> &'static str {
        "clamav"
    }
}

/// Speak the `clamd` INSTREAM protocol over a fresh TCP connection.
///
/// Wire format:
/// ```text
/// > zINSTREAM\0
/// > <chunk_len: u32 BE><chunk_bytes>...
/// > <0u32 BE>           # zero-length terminator
/// < "stream: OK\0"               → Clean
/// < "stream: <SIG> FOUND\0"      → Infected
/// < "<ERR> ERROR\0"              → Error
/// ```
async fn clamd_instream(addr: &str, path: &Path) -> std::io::Result<Verdict> {
    let mut stream = TcpStream::connect(addr).await?;

    // `z` prefix → null-terminated command (newline-terminated `n`
    // also works, but `z` is what every clamd-client lib uses).
    stream.write_all(b"zINSTREAM\0").await?;

    let mut file = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; INSTREAM_CHUNK_SIZE];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let len = (n as u32).to_be_bytes();
        stream.write_all(&len).await?;
        stream.write_all(&buf[..n]).await?;
    }
    // Zero-length terminator tells clamd we're done streaming.
    stream.write_all(&0u32.to_be_bytes()).await?;
    stream.flush().await?;

    // Response is small (one line, null-terminated).
    let mut resp = Vec::with_capacity(256);
    stream.read_to_end(&mut resp).await?;

    let text = String::from_utf8_lossy(&resp);
    let line = text.trim_end_matches('\0').trim_end_matches('\n').trim();

    // Examples we care about:
    //   "stream: OK"
    //   "stream: Win.Test.EICAR_HDB-1 FOUND"
    //   "INSTREAM size limit exceeded. ERROR"
    if line.ends_with(" FOUND") {
        let inner = line.trim_end_matches(" FOUND");
        let sig = inner
            .rsplit(": ")
            .next()
            .unwrap_or(inner)
            .trim()
            .to_string();
        Ok(Verdict::Infected { signature: sig })
    } else if line.ends_with(" OK") || line.eq_ignore_ascii_case("stream: ok") {
        Ok(Verdict::Clean)
    } else if line.to_ascii_uppercase().contains("ERROR") {
        Ok(Verdict::Error {
            message: line.to_string(),
        })
    } else {
        Ok(Verdict::Error {
            message: format!("unexpected clamd response: {line}"),
        })
    }
}

// ── Command backend (shell-out) ────────────────────────────────────

/// Shell-out scanner. Runs `command` with the temp-file path either
/// substituted for `{path}` or appended as the final argv. Exit code
/// convention (matches `clamdscan` and `mdatp scan custom`):
///
/// - `0` → clean
/// - `1` → infected; the **last non-empty line of stdout** is taken as
///   the signature (e.g. `mdatp` prints `Threat: Trojan.Foo`; the
///   client extracts `Trojan.Foo` automatically — see
///   [`extract_signature`])
/// - any other code → error (stderr captured in `message`)
#[derive(Debug, Clone)]
pub struct CommandScanner {
    pub command: String,
    pub max_scan_size: u64,
    pub timeout: Duration,
}

impl CommandScanner {
    pub fn new(command: String, max_scan_size: u64, timeout: Duration) -> Self {
        Self {
            command,
            max_scan_size,
            timeout,
        }
    }
}

#[async_trait::async_trait]
impl Scanner for CommandScanner {
    async fn scan(&self, path: &Path) -> Verdict {
        match tokio::fs::metadata(path).await {
            Ok(md) if md.len() > self.max_scan_size => {
                return Verdict::Skipped {
                    reason: "oversize".into(),
                };
            }
            Ok(_) => {}
            Err(e) => {
                return Verdict::Error {
                    message: format!("stat failed: {e}"),
                };
            }
        }

        let (program, args) = match build_argv(&self.command, path) {
            Some(v) => v,
            None => {
                return Verdict::Error {
                    message: "STRATA_AV_COMMAND is empty".into(),
                };
            }
        };

        let mut cmd = tokio::process::Command::new(&program);
        cmd.args(&args);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let fut = cmd.output();
        let out = match tokio::time::timeout(self.timeout, fut).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                return Verdict::Error {
                    message: format!("spawn failed: {e}"),
                };
            }
            Err(_) => {
                return Verdict::Error {
                    message: format!("scanner exceeded {} ms", self.timeout.as_millis()),
                };
            }
        };

        match out.status.code() {
            Some(0) => Verdict::Clean,
            Some(1) => Verdict::Infected {
                signature: extract_signature(&out.stdout, &out.stderr),
            },
            Some(code) => Verdict::Error {
                message: format!(
                    "scanner exit {code}: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
            },
            None => Verdict::Error {
                message: "scanner terminated by signal".into(),
            },
        }
    }
    fn backend_tag(&self) -> &'static str {
        "command"
    }
}

/// Split `command` into (program, args) and substitute `{path}` if
/// present; otherwise append `path` as the final argv slot.
///
/// Returns `None` only if the command is entirely empty / whitespace.
fn build_argv(command: &str, path: &Path) -> Option<(PathBuf, Vec<String>)> {
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }
    let program = PathBuf::from(parts[0]);
    let path_str = path.to_string_lossy().into_owned();
    let mut substituted = false;
    let mut args: Vec<String> = parts[1..]
        .iter()
        .map(|p| {
            if p.contains("{path}") {
                substituted = true;
                p.replace("{path}", &path_str)
            } else {
                (*p).to_string()
            }
        })
        .collect();
    if !substituted {
        args.push(path_str);
    }
    Some((program, args))
}

/// Pull the most likely signature name out of scanner output.
/// Prefers the last non-empty stdout line; falls back to stderr;
/// finally falls back to `"unknown"`.
fn extract_signature(stdout: &[u8], stderr: &[u8]) -> String {
    let pick = |bytes: &[u8]| -> Option<String> {
        String::from_utf8_lossy(bytes)
            .lines()
            .rev()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| {
                // Strip the common "Threat: " / "Found: " prefix so the
                // UI shows just the detection name.
                l.split_once(": ")
                    .map(|(_, sig)| sig.trim().to_string())
                    .unwrap_or_else(|| l.to_string())
            })
    };
    pick(stdout)
        .or_else(|| pick(stderr))
        .unwrap_or_else(|| "unknown".into())
}

// ── Factory ────────────────────────────────────────────────────────

/// Build the concrete [`Scanner`] from a [`Config`]. The returned
/// `Arc` is stored in `AppState` and shared across request tasks.
pub fn build(cfg: &Config) -> Arc<dyn Scanner> {
    match &cfg.backend {
        Backend::Off => {
            tracing::info!("AV scanning: disabled (STRATA_AV_BACKEND=off)");
            Arc::new(OffScanner)
        }
        Backend::ClamAv { addr } => {
            tracing::info!(
                addr = %addr,
                fail_mode = ?cfg.fail_mode,
                max_scan_size = cfg.max_scan_size,
                "AV scanning: ClamAV backend"
            );
            Arc::new(ClamAvScanner::new(
                addr.clone(),
                cfg.max_scan_size,
                cfg.timeout,
            ))
        }
        Backend::Command { command } => {
            tracing::info!(
                command = %command,
                fail_mode = ?cfg.fail_mode,
                max_scan_size = cfg.max_scan_size,
                "AV scanning: command backend"
            );
            Arc::new(CommandScanner::new(
                command.clone(),
                cfg.max_scan_size,
                cfg.timeout,
            ))
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_as_str_matches_db_vocabulary() {
        assert_eq!(Verdict::Clean.as_str(), "clean");
        assert_eq!(
            Verdict::Infected {
                signature: "X".into()
            }
            .as_str(),
            "infected"
        );
        assert_eq!(
            Verdict::Skipped {
                reason: "oversize".into()
            }
            .as_str(),
            "skipped"
        );
        assert_eq!(
            Verdict::Error {
                message: "boom".into()
            }
            .as_str(),
            "error"
        );
    }

    #[test]
    fn blocks_respects_fail_mode_on_error() {
        let err = Verdict::Error {
            message: "x".into(),
        };
        assert!(err.blocks(FailMode::Block));
        assert!(!err.blocks(FailMode::Allow));

        let infected = Verdict::Infected {
            signature: "x".into(),
        };
        assert!(infected.blocks(FailMode::Block));
        assert!(infected.blocks(FailMode::Allow));

        let clean = Verdict::Clean;
        assert!(!clean.blocks(FailMode::Block));
        assert!(!clean.blocks(FailMode::Allow));

        let skipped = Verdict::Skipped {
            reason: "oversize".into(),
        };
        assert!(!skipped.blocks(FailMode::Block));
    }

    #[test]
    fn user_facing_block_message_categorises_engine_output() {
        // Infected → names the signature.
        let infected = Verdict::Infected {
            signature: "Win.Test.EICAR_HDB-1".into(),
        };
        let m = infected.user_facing_block_message();
        assert!(m.contains("malware"));
        assert!(m.contains("Win.Test.EICAR_HDB-1"));

        // Timeout-shaped errors → WAR/archive guidance.
        for raw in [
            "clamd scan exceeded 120000 ms",
            "Time limit reached. ERROR",
            "scanner timed out after 30s",
            "command scan TIMEOUT",
        ] {
            let v = Verdict::Error {
                message: raw.into(),
            };
            let m = v.user_facing_block_message();
            assert!(
                m.to_lowercase().contains("timed out"),
                "expected timeout copy for {raw:?}, got {m:?}"
            );
            assert!(
                m.contains("WAR") || m.contains("archives") || m.contains("pre-extract"),
                "expected archive guidance for {raw:?}, got {m:?}"
            );
        }

        // Transport-shaped errors → retry-later guidance.
        for raw in [
            "clamd transport error: Connection refused (os error 111)",
            "broken pipe while writing INSTREAM chunk",
            "connection reset by peer",
        ] {
            let v = Verdict::Error {
                message: raw.into(),
            };
            let m = v.user_facing_block_message();
            assert!(
                m.to_lowercase().contains("unavailable"),
                "expected transport copy for {raw:?}, got {m:?}"
            );
            assert!(
                m.contains("try again") || m.contains("administrator"),
                "expected retry guidance for {raw:?}, got {m:?}"
            );
        }

        // Otherwise unrecognised → preserve raw engine message so
        // operators can debug from a screenshot.
        let other = Verdict::Error {
            message: "INSTREAM size limit exceeded but not really".into(),
        };
        // (this one happens to contain "exceeded" so it'll classify
        //  as timeout — that's the intended bias: a vague message that
        //  *might* be a timeout gets the friendlier copy, never the
        //  raw form.)
        let v = Verdict::Error {
            message: "freshclam ate my homework".into(),
        };
        assert!(
            v.user_facing_block_message().contains("freshclam ate my homework"),
            "unclassified error should pass through verbatim"
        );
        // Sanity-check the comment above: "exceeded" → timeout branch.
        assert!(other
            .user_facing_block_message()
            .to_lowercase()
            .contains("timed out"));
    }

    #[test]
    fn fail_mode_from_str_defaults_to_block() {
        assert_eq!(FailMode::from_str("block"), FailMode::Block);
        assert_eq!(FailMode::from_str("BLOCK"), FailMode::Block);
        assert_eq!(FailMode::from_str("garbage"), FailMode::Block);
        assert_eq!(FailMode::from_str(""), FailMode::Block);
        assert_eq!(FailMode::from_str("allow"), FailMode::Allow);
        assert_eq!(FailMode::from_str("ALLOW"), FailMode::Allow);
        assert_eq!(FailMode::from_str("pass"), FailMode::Allow);
        assert_eq!(FailMode::from_str("open"), FailMode::Allow);
    }

    #[test]
    fn build_argv_substitutes_placeholder() {
        let p = Path::new("/tmp/upload-1");
        let (prog, args) = build_argv("/usr/bin/scan --quick --in {path}", p).expect("non-empty");
        assert_eq!(prog, PathBuf::from("/usr/bin/scan"));
        assert_eq!(args, vec!["--quick", "--in", "/tmp/upload-1"]);
    }

    #[test]
    fn build_argv_appends_path_when_no_placeholder() {
        let p = Path::new("/tmp/upload-2");
        let (prog, args) = build_argv("/usr/bin/scan -q", p).expect("non-empty");
        assert_eq!(prog, PathBuf::from("/usr/bin/scan"));
        assert_eq!(args, vec!["-q", "/tmp/upload-2"]);
    }

    #[test]
    fn build_argv_rejects_empty_command() {
        assert!(build_argv("", Path::new("/tmp/x")).is_none());
        assert!(build_argv("   ", Path::new("/tmp/x")).is_none());
    }

    #[test]
    fn extract_signature_prefers_last_stdout_line() {
        let stdout = b"scanning...\nThreat: Win.Test.EICAR_HDB-1\n";
        let sig = extract_signature(stdout, b"");
        assert_eq!(sig, "Win.Test.EICAR_HDB-1");
    }

    #[test]
    fn extract_signature_falls_back_to_stderr() {
        let sig = extract_signature(b"", b"  Found: Trojan.Foo\n");
        assert_eq!(sig, "Trojan.Foo");
    }

    #[test]
    fn extract_signature_unknown_when_no_output() {
        assert_eq!(extract_signature(b"", b""), "unknown");
    }

    #[tokio::test]
    async fn off_scanner_always_skipped() {
        let s = OffScanner;
        let v = s.scan(Path::new("/dev/null")).await;
        assert_eq!(v.as_str(), "skipped");
    }

    #[tokio::test]
    async fn command_scanner_exit_zero_is_clean() {
        // `/bin/true` returns 0 and produces no output.
        let s = CommandScanner::new("/bin/true".into(), 1_000_000, Duration::from_secs(5));
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"hello").unwrap();
        let v = s.scan(tmp.path()).await;
        assert_eq!(v, Verdict::Clean);
    }

    #[tokio::test]
    async fn command_scanner_exit_one_is_infected() {
        // `/bin/false` always exits 1 with no output. Per the
        // exit-code contract that's "infected, signature unknown"
        // — exactly the verdict we'd want a real scanner to emit
        // when it found something but didn't print a name.
        // Skip if /bin/false is unavailable (Windows dev box).
        if !std::path::Path::new("/bin/false").exists() {
            return;
        }
        let s = CommandScanner::new("/bin/false".into(), 1_000_000, Duration::from_secs(5));
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"x").unwrap();
        let v = s.scan(tmp.path()).await;
        assert!(
            matches!(&v, Verdict::Infected { signature } if signature == "unknown"),
            "got {v:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_scanner_other_exit_is_error() {
        // We need a binary that exits with something other than 0 or
        // 1. `/bin/sh -c 'exit 2'` would do it, but our build_argv
        // does whitespace tokenisation rather than shell parsing, so
        // we ship a 2-line shell script via tempfile and chmod it +x.
        if !std::path::Path::new("/bin/sh").exists() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let script = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(script.path(), b"#!/bin/sh\nexit 2\n").unwrap();
        std::fs::set_permissions(script.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let s = CommandScanner::new(
            script.path().to_string_lossy().into_owned(),
            1_000_000,
            Duration::from_secs(5),
        );
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"x").unwrap();
        let v = s.scan(tmp.path()).await;
        assert!(matches!(v, Verdict::Error { .. }), "got {v:?}");
    }

    #[tokio::test]
    async fn command_scanner_oversize_skips() {
        // /bin/true would say clean; max_scan_size=1 forces skip.
        let s = CommandScanner::new("/bin/true".into(), 1, Duration::from_secs(5));
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"two bytes too many").unwrap();
        let v = s.scan(tmp.path()).await;
        assert!(matches!(v, Verdict::Skipped { .. }), "got {v:?}");
    }

    #[test]
    fn default_max_scan_size_matches_upload_cap() {
        // Must equal crate::services::file_store::MAX_FILE_SIZE so every
        // accepted upload is scanned — no silent oversize bypass.
        assert_eq!(DEFAULT_MAX_SCAN_SIZE, 500 * 1024 * 1024);
        assert_eq!(
            DEFAULT_MAX_SCAN_SIZE,
            crate::services::file_store::MAX_FILE_SIZE
        );
    }

    #[test]
    fn default_timeout_clear_of_typical_large_scan() {
        // 500 MB nested archives have been measured at 30–90 s on
        // modest hardware; a 2-min ceiling leaves comfortable headroom.
        assert_eq!(DEFAULT_TIMEOUT_MS, 120_000);
    }
}
