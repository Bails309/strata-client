//! Web Browser Session Spawn Runtime — rustguac parity end-to-end
//! orchestrator.
//!
//! This module owns the **observable lifecycle** of a `web` connection:
//! display + CDP port allocation → ephemeral profile directory →
//! Chromium Login Data autofill (rustguac parity C2/C3/C4) → Xvnc
//! spawn (B9) → readiness wait (B10) → Chromium spawn (B2–B6) →
//! crash-detect (B11) → optional login-script (D1–D4) → handle stored
//! in [`WebRuntimeRegistry`] for the tunnel route to look up.
//!
//! ## Layering
//!
//! - [`web_session`](super::web_session) owns the **pure-logic
//!   primitives** (allocators, argv builders, readiness poll,
//!   crash-detect, config types). Every helper there is pure and
//!   unit-tested without touching the filesystem or spawning processes.
//! - This module composes those primitives **with side effects**:
//!   `tempfile` directories, `tokio::process::Command::spawn`, registry
//!   inserts, audit log writes. The boundary is deliberate so the
//!   pure-logic layer keeps its 100%-deterministic test coverage.
//!
//! ## Drop semantics
//!
//! [`WebSessionHandle`] is **the** owner of every side effect:
//! Chromium child, Xvnc child, profile tempdir, display reservation,
//! CDP port reservation. Dropping the handle releases all of them —
//! including SIGKILL'ing both child processes via `kill_on_drop(true)`.
//! The registry holds `Arc<WebSessionHandle>`; when the last reference
//! drops (typically at session-end audit), cleanup is automatic.
//!
//! ## What is NOT here
//!
//! - The HTTP route. `routes/tunnel.rs` calls
//!   [`WebRuntimeRegistry::ensure`] and gets back a [`WebEndpoint`];
//!   that's the entire surface from the route's perspective.
//! - Per-tenant concurrency caps. `max_web_sessions` enforcement lives
//!   one layer up in `routes/tunnel.rs` so it can return a clean 429
//!   to the operator before any side effects fire.
//! - The reaper. Sessions are reaped by the existing
//!   `session_cleanup` job which removes inactive entries from
//!   [`WebRuntimeRegistry`]; the `Drop` impl on [`WebSessionHandle`]
//!   does the actual process/tempdir cleanup.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::web_autofill::{populate_login_data, LoginsRow, PopulateError};
use super::web_login_script::{
    resolve_script_path, run_login_script, Credentials, LoginScriptError,
};
use super::web_session::{
    chromium_command_args, detect_immediate_chromium_crash, vnc_port_for_display,
    wait_for_vnc_ready, xvnc_command_args, CdpPortAllocator, ChromiumLaunchSpec,
    ChromiumStartupCheck, WebDisplayAllocator, WebSessionConfig, WEB_CHROMIUM_SETTLE,
    WEB_DEFAULT_HEIGHT, WEB_DEFAULT_WIDTH, WEB_VNC_READY_DEADLINE,
};

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/// Where guacd should connect to reach the spawned kiosk's RFB
/// listener. Host is the backend container's service name on the
/// docker network (default `backend`, override via
/// `STRATA_WEB_VNC_HOST`); port is `5900 + display`. guacd runs in
/// a sibling container on the same `guac-internal` bridge network,
/// so it cannot reach the backend's `127.0.0.1` — we must give it a
/// hostname that resolves on the docker DNS plane.
#[derive(Debug, Clone)]
pub struct WebEndpoint {
    pub host: String,
    pub port: u16,
}

/// Inputs the registry needs from the tunnel route. Decoupled from
/// `connections.extra` parsing so this module never touches sqlx.
#[derive(Debug, Clone)]
pub struct WebSpawnSpec {
    /// From `connections.extra` via [`WebSessionConfig::from_extra`].
    pub config: WebSessionConfig,
    /// Connection's plaintext credentials, if the operator opted in
    /// to autofill. `None` skips Login Data writing entirely.
    pub credentials: Option<WebCredentials>,
    /// Filesystem path of the binary to spawn for Xvnc. Resolved by
    /// the route handler from [`SETTING_WEB_XVNC_PATH`].
    pub xvnc_binary: PathBuf,
    /// Filesystem path of the Chromium binary. Resolved from
    /// [`SETTING_WEB_CHROMIUM_PATH`].
    pub chromium_binary: PathBuf,
    /// Filesystem root for resolving login script identifiers.
    /// Resolved from [`SETTING_WEB_LOGIN_SCRIPTS_DIR`].
    pub login_scripts_dir: PathBuf,
    /// Initial framebuffer + window geometry. Threaded from the
    /// tunnel WS handler's `width`/`height` query params so the
    /// kiosk matches the operator's actual browser viewport. Pass
    /// `WEB_DEFAULT_WIDTH`/`WEB_DEFAULT_HEIGHT` for callers that
    /// don't have a viewport hint (e.g. unit tests).
    pub width: u16,
    pub height: u16,
    /// True when the backend container runs as root (the default
    /// compose stack). Mirrors rustguac's `geteuid() == 0` check;
    /// passed through to [`ChromiumLaunchSpec::running_as_root`].
    pub running_as_root: bool,
}

/// Plaintext username/password pair for autofill. Caller is expected
/// to source these from the same Vault path the tunnel uses, so the
/// plaintext only ever exists in memory for the duration of
/// `populate_login_data`'s encryption call (~ms).
#[derive(Debug, Clone)]
pub struct WebCredentials {
    pub username: String,
    pub password: String,
}

/// Database/operator-supplied default for the path to a registered
/// login script directory. Lives alongside the rest of the
/// `system_settings` table.
pub const SETTING_WEB_LOGIN_SCRIPTS_DIR: &str = "web_login_scripts_dir";

/// Default Xvnc readiness deadline override. Falls through to
/// [`WEB_VNC_READY_DEADLINE`] when unset. Exposed so operators can
/// extend it on slow CI runners without rebuilding.
#[allow(dead_code)]
pub const SETTING_WEB_VNC_READY_DEADLINE_MS: &str = "web_vnc_ready_deadline_ms";

/// Default Chromium settle window override. Falls through to
/// [`WEB_CHROMIUM_SETTLE`].
#[allow(dead_code)]
pub const SETTING_WEB_CHROMIUM_SETTLE_MS: &str = "web_chromium_settle_ms";

/// Login script timeout. Bounded — without this a hung script
/// blocks the session-start audit log indefinitely.
#[allow(dead_code)]
pub const SETTING_WEB_LOGIN_SCRIPT_TIMEOUT_MS: &str = "web_login_script_timeout_ms";

/// Default login script timeout (60 s). Matches rustguac.
pub const WEB_LOGIN_SCRIPT_DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum WebRuntimeError {
    #[error("display range exhausted (max concurrent web sessions)")]
    DisplayExhausted,
    #[error("CDP port range exhausted (max concurrent web sessions)")]
    CdpPortExhausted,
    #[error("filesystem error preparing profile: {0}")]
    Profile(#[from] std::io::Error),
    #[error("login data populate failed: {0}")]
    Autofill(#[from] PopulateError),
    #[error("Xvnc spawn failed: {0}")]
    XvncSpawn(String),
    #[error("Xvnc readiness wait timed out on display :{0}")]
    XvncNotReady(u16),
    #[error("Chromium spawn failed: {0}")]
    ChromiumSpawn(String),
    #[error("Chromium exited immediately: {0}")]
    ChromiumImmediateExit(String),
    #[error("login script failed: {0}")]
    LoginScript(#[from] LoginScriptError),
}

// ─────────────────────────────────────────────────────────────────────
// Session handle
// ─────────────────────────────────────────────────────────────────────

/// Owner of every side effect produced by spawning a web session.
///
/// **Drop is the cleanup path.** Don't add a separate `shutdown()` —
/// it would create two sources of truth and the `Drop` impl is
/// already guaranteed to run on registry eviction.
pub struct WebSessionHandle {
    /// Allocated display number, `100..=199`. Released on drop.
    pub display: u16,
    /// Allocated CDP port, `9222..=9321`. Released on drop.
    pub cdp_port: u16,
    /// Endpoint guacd connects to for the kiosk's RFB stream.
    pub endpoint: WebEndpoint,
    /// Wall-clock spawn time — surfaced in the
    /// `/api/admin/web-sessions` listing and in audit events.
    pub started_at: chrono::DateTime<chrono::Utc>,

    // ── owned resources (RAII) ───────────────────────────────────
    /// Tempdir holding Chromium's `--user-data-dir`. Removed on drop.
    profile_dir: tempfile::TempDir,
    /// Xvnc child handle. SIGKILL'd on drop via `kill_on_drop(true)`.
    _xvnc: Child,
    /// Chromium child handle. SIGKILL'd on drop via `kill_on_drop(true)`.
    _chromium: Child,
    /// Display allocator we must release into. Held as `Arc` so the
    /// allocator outlives every handle.
    displays: Arc<WebDisplayAllocator>,
    /// CDP port allocator we must release into.
    cdp_ports: Arc<CdpPortAllocator>,
}

impl std::fmt::Debug for WebSessionHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSessionHandle")
            .field("display", &self.display)
            .field("cdp_port", &self.cdp_port)
            .field("endpoint", &self.endpoint)
            .field("started_at", &self.started_at)
            .field("profile_dir", &self.profile_dir.path())
            .finish()
    }
}

impl Drop for WebSessionHandle {
    fn drop(&mut self) {
        // Allocators must be released even if children are already
        // dead. The `kill_on_drop(true)` flag on the children handles
        // process termination.
        self.displays.release(self.display);
        self.cdp_ports.release(self.cdp_port);
        // `tempfile::TempDir`'s own Drop impl removes the directory
        // tree.
    }
}

// ─────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────

/// Map key: `(connection_id, user_id)`. Matches rustguac's "one
/// kiosk per (entry, user)" invariant. Re-using the same connection
/// across browser tabs joins the existing kiosk; opening it as a
/// different user spawns a fresh one.
type RegistryKey = (Uuid, Uuid);

/// Process-global registry of live web sessions. Held on
/// [`crate::services::app_state::AppState`] as `Arc<WebRuntimeRegistry>`.
///
/// Internally a `Mutex<HashMap<...>>` rather than `RwLock` because
/// the spawn path needs an exclusive insert and the read path is
/// never hot (looked up at most once per WebSocket upgrade).
pub struct WebRuntimeRegistry {
    inner: Mutex<HashMap<RegistryKey, Arc<WebSessionHandle>>>,
    displays: Arc<WebDisplayAllocator>,
    cdp_ports: Arc<CdpPortAllocator>,
}

impl WebRuntimeRegistry {
    pub fn new(displays: Arc<WebDisplayAllocator>) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            displays,
            cdp_ports: Arc::new(CdpPortAllocator::new()),
        }
    }

    /// Look up an existing session without spawning. Returned `Arc`
    /// keeps the session alive even if it's evicted between the
    /// lookup and the WebSocket upgrade.
    pub async fn get(
        &self,
        connection_id: Uuid,
        user_id: Uuid,
    ) -> Option<Arc<WebSessionHandle>> {
        self.inner
            .lock()
            .await
            .get(&(connection_id, user_id))
            .cloned()
    }

    /// Get-or-spawn entry point for the tunnel route.
    ///
    /// Spawn pipeline (rustguac parity, in this exact order — order
    /// matters: Login Data must exist *before* Chromium opens the
    /// profile, and Chromium must not start until Xvnc accepts on
    /// `:5900+N`):
    ///
    /// 1. Allocate display + CDP port. Both released on any failure
    ///    via the [`WebSessionHandle`] Drop impl, even mid-spawn.
    /// 2. Create the profile tempdir.
    /// 3. If credentials are present, write Login Data + Preferences
    ///    (C3 + C4).
    /// 4. Spawn Xvnc (B9) and wait for the listener (B10).
    /// 5. Spawn Chromium (B2–B6).
    /// 6. Wait the settle window and verify Chromium didn't fast-fail
    ///    (B11).
    /// 7. If a login script is configured, run it (D1–D4) bounded by
    ///    [`WEB_LOGIN_SCRIPT_DEFAULT_TIMEOUT`] (operator-overridable).
    /// 8. Insert into the registry and return the endpoint.
    pub async fn ensure(
        &self,
        connection_id: Uuid,
        user_id: Uuid,
        session_id: &str,
        spec: WebSpawnSpec,
    ) -> Result<Arc<WebSessionHandle>, WebRuntimeError> {
        // Fast path: already running.
        if let Some(existing) = self.get(connection_id, user_id).await {
            return Ok(existing);
        }

        // Step 1: allocate. Failure here is fatal — caller surfaces
        // 503 or 429 depending on `max_web_sessions`.
        let display = self
            .displays
            .allocate()
            .ok_or(WebRuntimeError::DisplayExhausted)?;
        // From here on, any failure must release the display.
        let display_guard = AllocGuard::new(self.displays.clone(), display);

        let cdp_port = self
            .cdp_ports
            .allocate()
            .ok_or(WebRuntimeError::CdpPortExhausted)?;
        let cdp_guard = CdpAllocGuard::new(self.cdp_ports.clone(), cdp_port);

        // Step 2: profile tempdir.
        let profile_dir = tempfile::Builder::new()
            .prefix("strata-web-")
            .tempdir()
            .map_err(WebRuntimeError::Profile)?;

        // Step 3: autofill (C3 + C4).
        if let Some(creds) = &spec.credentials {
            let row = LoginsRow::new(
                spec.config.url.clone(),
                spec.config.url.clone(),
                signon_realm_for(&spec.config.url),
                creds.username.clone(),
                &creds.password,
                chrono::Utc::now().timestamp_micros(),
            );
            populate_login_data(profile_dir.path(), &[row])?;
        } else {
            // Even with no credentials we still write Preferences so
            // Chromium's password manager UI is in the expected state
            // when the user types one in manually.
            populate_login_data(profile_dir.path(), &[])?;
        }

        // Step 4: Xvnc spawn (B9). Geometry is per-session, sourced
        // from the tunnel handler's viewport hint so the framebuffer
        // matches the operator's browser tab.
        let geom_w = if spec.width == 0 { WEB_DEFAULT_WIDTH } else { spec.width };
        let geom_h = if spec.height == 0 { WEB_DEFAULT_HEIGHT } else { spec.height };
        let xvnc_argv = xvnc_command_args(
            &spec.xvnc_binary.to_string_lossy(),
            display,
            geom_w,
            geom_h,
        );
        // argv[0] is the binary path; remaining elements are args.
        let xvnc = spawn_silent(&xvnc_argv).map_err(|e| WebRuntimeError::XvncSpawn(e.to_string()))?;

        // Step 4b: readiness (B10).
        if !wait_for_vnc_ready(display, WEB_VNC_READY_DEADLINE).await {
            // `xvnc` is dropped here → SIGKILL'd via kill_on_drop.
            return Err(WebRuntimeError::XvncNotReady(display));
        }

        // Step 5: Chromium spawn (B2–B6).
        let chromium_args = chromium_command_args(&ChromiumLaunchSpec {
            url: &spec.config.url,
            user_data_dir: profile_dir.path(),
            allowed_domains: &spec.config.allowed_domains,
            remote_debugging_port: cdp_port,
            running_as_root: spec.running_as_root,
            window_width: geom_w,
            window_height: geom_h,
        });
        let chromium = spawn_chromium(&spec.chromium_binary, &chromium_args, display)
            .map_err(|e| WebRuntimeError::ChromiumSpawn(e.to_string()))?;

        // Step 6: crash-detect (B11). Mutate-in-place: detect_*
        // borrows the child mutably to call `try_wait`.
        let mut chromium = chromium;
        match detect_immediate_chromium_crash(&mut chromium, WEB_CHROMIUM_SETTLE).await {
            ChromiumStartupCheck::StillRunning => {}
            ChromiumStartupCheck::Exited(status) => {
                return Err(WebRuntimeError::ChromiumImmediateExit(format!(
                    "exit status {status}"
                )));
            }
            ChromiumStartupCheck::WaitError(e) => {
                return Err(WebRuntimeError::ChromiumImmediateExit(format!(
                    "try_wait error: {e}"
                )));
            }
        }

        // Step 7: optional login script (D1–D4).
        if let Some(script_id) = &spec.config.login_script {
            let script_path = resolve_script_path(&spec.login_scripts_dir, script_id)?;
            let creds = spec.credentials.clone().unwrap_or(WebCredentials {
                username: String::new(),
                password: String::new(),
            });
            let script_creds = Credentials {
                username: creds.username,
                password: creds.password,
                url: spec.config.url.clone(),
                cdp_port,
                session_id: session_id.to_string(),
            };
            let display_str = format!(":{display}");
            run_login_script(
                &script_path,
                &display_str,
                &script_creds,
                WEB_LOGIN_SCRIPT_DEFAULT_TIMEOUT,
            )
            .await?;
        }

        // Step 8: register + return.
        // Disarm the guards now that we're handing ownership to the
        // `WebSessionHandle`. From here onward, cleanup is the
        // handle's Drop impl.
        display_guard.disarm();
        cdp_guard.disarm();
        let handle = Arc::new(WebSessionHandle {
            display,
            cdp_port,
            endpoint: WebEndpoint {
                host: std::env::var("STRATA_WEB_VNC_HOST")
                    .unwrap_or_else(|_| "backend".to_string()),
                port: vnc_port_for_display(display),
            },
            started_at: chrono::Utc::now(),
            profile_dir,
            _xvnc: xvnc,
            _chromium: chromium,
            displays: self.displays.clone(),
            cdp_ports: self.cdp_ports.clone(),
        });
        self.inner
            .lock()
            .await
            .insert((connection_id, user_id), handle.clone());
        Ok(handle)
    }

    /// Evict and drop the handle for `(connection_id, user_id)`.
    /// Returns `true` if a session was present.
    #[allow(dead_code)]
    pub async fn evict(&self, connection_id: Uuid, user_id: Uuid) -> bool {
        self.inner
            .lock()
            .await
            .remove(&(connection_id, user_id))
            .is_some()
    }

    /// Live session count. Surface for `/api/admin/web-sessions/stats`.
    pub async fn len(&self) -> usize {
        self.inner.lock().await.len()
    }

    /// Convenience for completeness with `len()`.
    #[allow(dead_code)]
    pub async fn is_empty(&self) -> bool {
        self.inner.lock().await.is_empty()
    }
}

impl std::fmt::Debug for WebRuntimeRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebRuntimeRegistry").finish_non_exhaustive()
    }
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

/// Spawn argv where `argv[0]` is the binary path. Stdout/stderr are
/// silenced — Xvnc and Chromium are extremely chatty and a chatty
/// child can fill the pipe buffer and deadlock the parent.
fn spawn_silent(argv: &[String]) -> std::io::Result<Child> {
    let (program, rest) = argv
        .split_first()
        .expect("argv must have at least the binary path");
    Command::new(program)
        .args(rest)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
}

/// Chromium needs the `DISPLAY` env var pointing at the Xvnc display
/// we just spawned. Everything else is silenced as in `spawn_silent`.
fn spawn_chromium(
    binary: &std::path::Path,
    args: &[String],
    display: u16,
) -> std::io::Result<Child> {
    Command::new(binary)
        .args(args)
        .env("DISPLAY", format!(":{display}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
}

/// `https://example.com/login` → `https://example.com/`. Chromium's
/// password manager keys on the (scheme + host + port) triple; the
/// path is dropped. Anything we can't parse falls through unchanged
/// so the autofill path still tries — if Chromium rejects the realm
/// it just won't autofill, which is the same behaviour as omitting
/// the row.
fn signon_realm_for(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        let scheme = parsed.scheme();
        let host = parsed.host_str().unwrap_or("");
        match parsed.port() {
            Some(p) => format!("{scheme}://{host}:{p}/"),
            None => format!("{scheme}://{host}/"),
        }
    } else {
        url.to_string()
    }
}

/// RAII guard that releases an allocated display number on drop
/// unless [`AllocGuard::disarm`] was called first. Used during the
/// spawn pipeline so any `?` early-return frees the display.
struct AllocGuard {
    allocator: Arc<WebDisplayAllocator>,
    display: u16,
    armed: bool,
}

impl AllocGuard {
    fn new(allocator: Arc<WebDisplayAllocator>, display: u16) -> Self {
        Self {
            allocator,
            display,
            armed: true,
        }
    }
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for AllocGuard {
    fn drop(&mut self) {
        if self.armed {
            self.allocator.release(self.display);
        }
    }
}

/// Mirror of [`AllocGuard`] for CDP ports. Two structs because the
/// allocators are different concrete types and a generic over both
/// would just obscure the call sites.
struct CdpAllocGuard {
    allocator: Arc<CdpPortAllocator>,
    port: u16,
    armed: bool,
}

impl CdpAllocGuard {
    fn new(allocator: Arc<CdpPortAllocator>, port: u16) -> Self {
        Self {
            allocator,
            port,
            armed: true,
        }
    }
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for CdpAllocGuard {
    fn drop(&mut self) {
        if self.armed {
            self.allocator.release(self.port);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signon_realm_strips_path() {
        assert_eq!(
            signon_realm_for("https://example.com/login"),
            "https://example.com/"
        );
    }

    #[test]
    fn signon_realm_preserves_port() {
        assert_eq!(
            signon_realm_for("https://example.com:8443/x"),
            "https://example.com:8443/"
        );
    }

    #[test]
    fn signon_realm_passes_through_unparseable() {
        // Not a valid URL → caller gets the raw string back; Chromium
        // will simply ignore it.
        assert_eq!(signon_realm_for("not a url"), "not a url");
    }

    #[test]
    fn alloc_guard_releases_on_drop_when_armed() {
        let alloc = Arc::new(WebDisplayAllocator::new());
        let n = alloc.allocate().expect("range not exhausted");
        assert_eq!(alloc.in_use_count(), 1);
        {
            let _g = AllocGuard::new(alloc.clone(), n);
            // dropped here → release
        }
        assert_eq!(alloc.in_use_count(), 0);
    }

    #[test]
    fn alloc_guard_holds_when_disarmed() {
        let alloc = Arc::new(WebDisplayAllocator::new());
        let n = alloc.allocate().expect("range not exhausted");
        let g = AllocGuard::new(alloc.clone(), n);
        g.disarm();
        // Disarmed → drop must NOT release. Caller now owns the
        // reservation and is responsible for releasing it.
        assert_eq!(alloc.in_use_count(), 1);
        alloc.release(n);
        assert_eq!(alloc.in_use_count(), 0);
    }

    #[test]
    fn cdp_guard_releases_on_drop_when_armed() {
        let alloc = Arc::new(CdpAllocGuard::new(
            Arc::new(CdpPortAllocator::new()),
            9999, // ignored — we test by counting on a fresh allocator
        ));
        // Above just exercises construction; the real test is below.
        drop(alloc);

        let allocator = Arc::new(CdpPortAllocator::new());
        let p = allocator.allocate().expect("range not exhausted");
        assert_eq!(allocator.in_use_count(), 1);
        {
            let _g = CdpAllocGuard::new(allocator.clone(), p);
        }
        assert_eq!(allocator.in_use_count(), 0);
    }

    #[tokio::test]
    async fn registry_starts_empty() {
        let alloc = Arc::new(WebDisplayAllocator::new());
        let reg = WebRuntimeRegistry::new(alloc);
        assert_eq!(reg.len().await, 0);
        assert!(reg.is_empty().await);
    }

    #[tokio::test]
    async fn registry_get_returns_none_for_unknown_session() {
        let alloc = Arc::new(WebDisplayAllocator::new());
        let reg = WebRuntimeRegistry::new(alloc);
        let h = reg.get(Uuid::new_v4(), Uuid::new_v4()).await;
        assert!(h.is_none());
    }

    #[tokio::test]
    async fn registry_evict_returns_false_for_unknown_session() {
        let alloc = Arc::new(WebDisplayAllocator::new());
        let reg = WebRuntimeRegistry::new(alloc);
        let evicted = reg.evict(Uuid::new_v4(), Uuid::new_v4()).await;
        assert!(!evicted);
    }
}
