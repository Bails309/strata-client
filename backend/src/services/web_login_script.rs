// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! External login-script runner — rustguac parity D1–D4 (tracker
//! [`docs/runbooks/rustguac-parity-tracker.md`]).
//!
//! ## Overview
//!
//! The **primary** path for automating logins on a `web` connection is
//! to spawn an operator-supplied executable that drives Chromium
//! itself (typically via Playwright, Puppeteer, or a raw CDP client
//! in the operator's language of choice). Strata provides:
//!
//! 1. **Path validation** — the configured script identifier is
//!    canonicalised against the operator's `login_scripts_dir` and
//!    rejected if it escapes the dir or isn't executable. This
//!    prevents arbitrary-binary execution from a `connections.extra`
//!    string.
//! 2. **Process spawn** — `tokio::process::Command` with a fixed env
//!    surface (`DISPLAY`, `STRATA_CDP_PORT`, `STRATA_URL`,
//!    `STRATA_SESSION_ID`) and the credentials piped via stdin as a
//!    single JSON object.
//! 3. **Bounded timeout** — the spawn-runtime caller picks the
//!    deadline; on expiry the process is killed.
//!
//! This module compiles on all platforms but the executable-bit check
//! is `cfg(unix)` only. Strata's runtime image is Linux, so on Windows
//! the check is skipped (used for unit-test ergonomics).
//!
//! ## Why external scripts (rustguac parity D1)
//!
//! The in-process CDP DSL ([`super::web_cdp`]) forces Strata to chase
//! Chromium's CDP version drift; the external-script approach keeps
//! that maintenance burden with the operator. See tracker section D
//! for the full rationale.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Errors emitted by [`run_login_script`].
#[derive(Debug, thiserror::Error)]
pub enum LoginScriptError {
    /// The script identifier could not be resolved relative to
    /// `login_scripts_dir`. Either the file doesn't exist, or
    /// canonicalisation placed it outside the configured directory.
    #[error("invalid script path: {0}")]
    InvalidPath(String),
    /// The resolved path exists and lives inside
    /// `login_scripts_dir`, but lacks the executable bit (Unix only).
    #[error("script is not executable: {0}")]
    NotExecutable(PathBuf),
    /// `tokio::process::Command::spawn` returned an error before the
    /// child process was running (e.g. permission denied, exec fmt).
    #[error("spawn failed: {0}")]
    Spawn(#[from] std::io::Error),
    /// stdin marshalling failed — should not happen given `Credentials`
    /// is fully serialisable, but surfaced for completeness.
    #[error("stdin encode failed: {0}")]
    StdinEncode(#[from] serde_json::Error),
    /// Script exited with a non-zero status. The exit code (or signal
    /// description on Unix) is included.
    #[error("script exited non-zero: {0}")]
    NonZeroExit(String),
    /// Script ran longer than the per-call deadline and was killed.
    #[error("script timed out after {0:?}")]
    Timeout(Duration),
}

/// Per-spawn context piped to the script as stdin JSON. Mirrors the
/// rustguac stdin contract.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Credentials {
    /// Plaintext username for the form. The script is responsible for
    /// typing this into the appropriate field.
    pub username: String,
    /// Plaintext password. Kept on the wire only as long as the
    /// script is running (stdin pipe; never lands on disk on
    /// Strata's side).
    pub password: String,
    /// The target URL the kiosk has navigated to. Provided so the
    /// script can branch on host/path without re-deriving it.
    pub url: String,
    /// Chromium's `--remote-debugging-port`. The script connects here
    /// to drive CDP.
    pub cdp_port: u16,
    /// Opaque per-session identifier for log correlation. Same value
    /// is also exposed via the `STRATA_SESSION_ID` env var so that
    /// shell-based scripts that don't parse stdin JSON can still log
    /// it.
    pub session_id: String,
}

/// Resolve `script_identifier` to an absolute, canonicalised path
/// inside `scripts_dir`. Returns `Err(InvalidPath)` if the resolved
/// path escapes `scripts_dir` or doesn't exist; returns
/// `Err(NotExecutable)` (Unix only) if the file lacks the exec bit.
///
/// The operator-facing `login_script` field on `connections.extra` is
/// expected to be a plain filename or relative path — never an
/// absolute path. We refuse absolute paths and `..` traversal because
/// arbitrary-path execution would let any connection-edit RBAC role
/// pick a system binary as the "login script".
pub fn resolve_script_path(
    scripts_dir: &Path,
    script_identifier: &str,
) -> Result<PathBuf, LoginScriptError> {
    if script_identifier.is_empty() {
        return Err(LoginScriptError::InvalidPath(
            "empty script identifier".to_string(),
        ));
    }
    let raw = Path::new(script_identifier);
    if raw.is_absolute() {
        return Err(LoginScriptError::InvalidPath(format!(
            "absolute paths not allowed: {script_identifier}"
        )));
    }
    if raw.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(LoginScriptError::InvalidPath(format!(
            "`..` traversal not allowed: {script_identifier}"
        )));
    }

    // Canonicalise both sides so symlinks, `.` segments, and casing
    // (on case-insensitive filesystems) compare consistently.
    let dir_canon = scripts_dir.canonicalize().map_err(|e| {
        LoginScriptError::InvalidPath(format!("scripts_dir not accessible: {e}"))
    })?;
    let candidate = dir_canon.join(raw);
    let candidate_canon = candidate.canonicalize().map_err(|e| {
        LoginScriptError::InvalidPath(format!("script not found: {script_identifier} ({e})"))
    })?;
    if !candidate_canon.starts_with(&dir_canon) {
        return Err(LoginScriptError::InvalidPath(format!(
            "script escapes scripts_dir: {script_identifier}"
        )));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(&candidate_canon)
            .map_err(|e| LoginScriptError::InvalidPath(format!("metadata read failed: {e}")))?;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(LoginScriptError::NotExecutable(candidate_canon));
        }
    }

    Ok(candidate_canon)
}

/// Spawn `script_path` (already validated by [`resolve_script_path`])
/// and feed it the credentials over stdin. Awaits completion within
/// `timeout`; kills the process and returns
/// [`LoginScriptError::Timeout`] on expiry.
///
/// Env vars set on the child:
/// - `DISPLAY` — the Xvnc display number, e.g. `:101`
/// - `STRATA_CDP_PORT` — Chromium's `--remote-debugging-port`
/// - `STRATA_URL` — the page URL the kiosk has navigated to
/// - `STRATA_SESSION_ID` — opaque per-session identifier
pub async fn run_login_script(
    script_path: &Path,
    display: &str,
    credentials: &Credentials,
    timeout: Duration,
) -> Result<(), LoginScriptError> {
    let stdin_json = serde_json::to_vec(credentials)?;

    let mut child = Command::new(script_path)
        .env_clear()
        .env("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
        .env("DISPLAY", display)
        .env("STRATA_CDP_PORT", credentials.cdp_port.to_string())
        .env("STRATA_URL", &credentials.url)
        .env("STRATA_SESSION_ID", &credentials.session_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&stdin_json).await?;
        stdin.shutdown().await?;
    }

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(s) => s?,
        Err(_) => {
            // Best-effort kill; tokio's kill_on_drop also handles the
            // drop path if we propagate the error before child is
            // reaped.
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(LoginScriptError::Timeout(timeout));
        }
    };

    if !status.success() {
        return Err(LoginScriptError::NonZeroExit(format!("{status}")));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_identifier() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = resolve_script_path(dir.path(), "").unwrap_err();
        assert!(matches!(err, LoginScriptError::InvalidPath(_)));
    }

    #[test]
    fn rejects_absolute_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        #[cfg(windows)]
        let abs = "C:\\Windows\\System32\\cmd.exe";
        #[cfg(unix)]
        let abs = "/bin/sh";
        let err = resolve_script_path(dir.path(), abs).unwrap_err();
        assert!(matches!(err, LoginScriptError::InvalidPath(_)));
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = resolve_script_path(dir.path(), "../etc/passwd").unwrap_err();
        assert!(matches!(err, LoginScriptError::InvalidPath(_)));
    }

    #[test]
    fn rejects_missing_script() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = resolve_script_path(dir.path(), "does-not-exist.sh").unwrap_err();
        assert!(matches!(err, LoginScriptError::InvalidPath(_)));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_executable_script() {
        use std::io::Write;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("login.sh");
        let mut f = std::fs::File::create(&path).expect("create");
        writeln!(f, "#!/bin/sh\necho hi").unwrap();
        // Leave default permissions (no exec bit on most umasks).
        let err = resolve_script_path(dir.path(), "login.sh").unwrap_err();
        assert!(matches!(err, LoginScriptError::NotExecutable(_)));
    }

    #[cfg(unix)]
    #[test]
    fn accepts_executable_script() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("login.sh");
        let mut f = std::fs::File::create(&path).expect("create");
        writeln!(f, "#!/bin/sh\nexit 0").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");
        let resolved = resolve_script_path(dir.path(), "login.sh").expect("resolve");
        assert_eq!(resolved.canonicalize().unwrap(), path.canonicalize().unwrap());
    }

    #[test]
    fn credentials_serialise_to_expected_keys() {
        // Lock in the stdin JSON contract — operator scripts written
        // against this surface must keep working across Strata
        // upgrades. Adding a field is additive (operators see new
        // keys); renaming or removing one is a breaking change.
        let creds = Credentials {
            username: "alice".to_string(),
            password: "p@ss\"word".to_string(),
            url: "https://example.com/login".to_string(),
            cdp_port: 9222,
            session_id: "sess-abc".to_string(),
        };
        let v: serde_json::Value =
            serde_json::from_slice(&serde_json::to_vec(&creds).unwrap()).unwrap();
        assert_eq!(v["username"], "alice");
        assert_eq!(v["password"], "p@ss\"word"); // Quotes round-trip cleanly.
        assert_eq!(v["url"], "https://example.com/login");
        assert_eq!(v["cdp_port"], 9222);
        assert_eq!(v["session_id"], "sess-abc");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_succeeds_with_zero_exit() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ok.sh");
        let mut f = std::fs::File::create(&path).expect("create");
        // Read stdin to /dev/null so the pipe doesn't EPIPE-trip the
        // parent-side write.
        writeln!(f, "#!/bin/sh\ncat >/dev/null\nexit 0").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");
        let creds = Credentials {
            username: "u".into(),
            password: "p".into(),
            url: "https://x".into(),
            cdp_port: 9222,
            session_id: "s".into(),
        };
        run_login_script(&path, ":101", &creds, Duration::from_secs(5))
            .await
            .expect("script ok");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_surfaces_non_zero_exit() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("fail.sh");
        let mut f = std::fs::File::create(&path).expect("create");
        writeln!(f, "#!/bin/sh\ncat >/dev/null\nexit 7").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");
        let creds = Credentials {
            username: "u".into(),
            password: "p".into(),
            url: "https://x".into(),
            cdp_port: 9222,
            session_id: "s".into(),
        };
        let err = run_login_script(&path, ":101", &creds, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(matches!(err, LoginScriptError::NonZeroExit(_)), "got {err:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_kills_on_timeout() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("slow.sh");
        let mut f = std::fs::File::create(&path).expect("create");
        writeln!(f, "#!/bin/sh\nsleep 30\nexit 0").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");
        let creds = Credentials {
            username: "u".into(),
            password: "p".into(),
            url: "https://x".into(),
            cdp_port: 9222,
            session_id: "s".into(),
        };
        let err = run_login_script(&path, ":101", &creds, Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(matches!(err, LoginScriptError::Timeout(_)), "got {err:?}");
    }
}
