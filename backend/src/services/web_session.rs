// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Web Browser Sessions — shipped in v0.30.0 (roadmap item
//! `protocols-web-sessions`).
//!
//! A `web` connection launches an ephemeral Chromium kiosk inside an
//! Xvnc display and tunnels it through guacd as a standard VNC session.
//! The Strata frontend treats it identically to any other VNC connection;
//! the differentiator is purely server-side.
//!
//! This module hosts the **pure-logic foundation** of that pipeline:
//!
//! 1. [`WebDisplayAllocator`] — thread-safe allocator over the
//!    `:100`–`:199` X-display range. Each web session owns one display
//!    for its lifetime; freed on session end.
//! 2. [`WebSessionConfig`] — typed view of the connection's `extra`
//!    JSONB column (URL, allowed_domains, login_script).
//! 3. [`is_host_allowed_by_cidr`] — egress guard implementing the
//!    `web_allowed_networks` system setting (SSRF protection — a Chromium
//!    kiosk pointed at `http://169.254.169.254/` would otherwise be a
//!    cloud-metadata exfiltration vector).
//! 4. [`chromium_command_args`] — kiosk argv builder mirroring rustguac's
//!    Chromium invocation (kiosk mode, ephemeral profile, host-rules
//!    domain restriction, remote-debugging port for login automation).
//!
//! **Not in this module (deferred deliverables, tracked separately):**
//!
//! - Actual Xvnc / Chromium process spawning. Requires installing
//!   `xvfb-run` (or `Xvnc`) and Chromium in the backend Dockerfile and a
//!   sandboxing review.
//! - Translation of `web` → `vnc` in the tunnel handshake. Wires in once
//!   spawning is real.
//! - Chromium Login Data SQLite autofill writer. Independent crypto code
//!   (PBKDF2-SHA1 / AES-128-CBC) tracked as its own follow-up.
//! - Login automation runner over Chrome DevTools Protocol.

use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::Mutex;

use ipnet::IpNet;
use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────
// Display allocator
// ─────────────────────────────────────────────────────────────────────

/// Lowest X-display number rented by web sessions. Numbers below this
/// are conventionally used by host display servers (`:0`, `:1`, …).
pub const WEB_DISPLAY_MIN: u16 = 100;

/// Highest X-display number rented by web sessions, inclusive. Mirrors
/// rustguac's `:100`–`:199` range, capping concurrent web sessions at 100.
pub const WEB_DISPLAY_MAX: u16 = 199;

// ─────────────────────────────────────────────────────────────────────
// Audit event action_type strings (stable operator-facing contract)
// ─────────────────────────────────────────────────────────────────────

// `#[allow(dead_code)]` on the audit/settings surface: the constants
// freeze the operator-facing contract (audit action_type strings,
// system_settings keys) ahead of the deferred runtime that consumes
// them. Removing the annotation when the live spawn lands.

/// Emitted when a web session is successfully spawned. Details:
/// `{connection_id, display, url, allowed_domains_count}`.
#[allow(dead_code)]
pub const AUDIT_WEB_SESSION_START: &str = "web.session.start";

/// Emitted when a web session terminates (any reason). Details:
/// `{connection_id, display, duration_secs, reason}`.
#[allow(dead_code)]
pub const AUDIT_WEB_SESSION_END: &str = "web.session.end";

/// Emitted when the autofill writer persists Login Data for a session.
/// Details: `{connection_id, target_host, username_present, password_present}`
/// — never logs the password itself.
#[allow(dead_code)]
pub const AUDIT_WEB_AUTOFILL_WRITE: &str = "web.autofill.write";

// ─────────────────────────────────────────────────────────────────────
// system_settings keys
// ─────────────────────────────────────────────────────────────────────

/// Newline-/comma-separated CIDR allow-list controlling which IPs the
/// kiosk Chromium is permitted to connect to. Empty ⇒ deny all.
#[allow(dead_code)]
pub const SETTING_WEB_ALLOWED_NETWORKS: &str = "web_allowed_networks";

/// Per-replica concurrency cap on simultaneous web sessions. Capped by
/// [`WebDisplayAllocator::capacity`] regardless. Stored as a stringified
/// `u32`; missing or unparseable ⇒ falls back to the allocator capacity.
#[allow(dead_code)]
pub const SETTING_MAX_WEB_SESSIONS: &str = "max_web_sessions";

// ── Operator-tunable runtime paths (rustguac parity item B12) ──────
//
// rustguac exposes `xvnc_path`, `chromium_path`, `display_range_start`,
// `display_range_end` as config keys so an operator can swap the
// binaries (e.g. point at `/opt/chromium/bin/chrome` on a hardened
// image) without rebuilding. Strata mirrors these as `system_settings`
// rows; the spawn runtime reads them at session-start time.

/// Filesystem path to the Xvnc binary. Default `Xvnc` (resolved via $PATH).
#[allow(dead_code)]
pub const SETTING_WEB_XVNC_PATH: &str = "web_xvnc_path";

/// Filesystem path to the Chromium binary. Default `chromium`.
#[allow(dead_code)]
pub const SETTING_WEB_CHROMIUM_PATH: &str = "web_chromium_path";

/// Lowest X-display number rented by web sessions. Default
/// [`WEB_DISPLAY_MIN`].
#[allow(dead_code)]
pub const SETTING_WEB_DISPLAY_RANGE_START: &str = "web_display_range_start";

/// Highest X-display number rented by web sessions, inclusive. Default
/// [`WEB_DISPLAY_MAX`].
#[allow(dead_code)]
pub const SETTING_WEB_DISPLAY_RANGE_END: &str = "web_display_range_end";

// ─────────────────────────────────────────────────────────────────────
// CDP port allocator (rustguac parity item B2)
// ─────────────────────────────────────────────────────────────────────

/// Lowest port handed out for Chromium's `--remote-debugging-port`.
/// Mirrors rustguac's CDP port range — 100 slots, one per concurrent
/// web session, paired 1:1 with the display allocation.
pub const WEB_CDP_PORT_MIN: u16 = 9222;

/// Highest CDP port, inclusive.
pub const WEB_CDP_PORT_MAX: u16 = 9321;

/// Thread-safe allocator over the CDP port range. Allocated alongside
/// a display at session start, released at session end. Bound to
/// `127.0.0.1` only (see [`chromium_command_args`]); the port number
/// never leaves the backend container.
#[derive(Debug, Default)]
pub struct CdpPortAllocator {
    in_use: Mutex<HashSet<u16>>,
}

impl CdpPortAllocator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve the next free CDP port, or return `None` when the
    /// range is exhausted.
    pub fn allocate(&self) -> Option<u16> {
        let mut in_use = self
            .in_use
            .lock()
            .expect("CDP port allocator mutex poisoned");
        (WEB_CDP_PORT_MIN..=WEB_CDP_PORT_MAX).find(|&n| in_use.insert(n))
    }

    /// Release a previously allocated port. No-op if the port was never
    /// allocated.
    pub fn release(&self, port: u16) {
        if let Ok(mut in_use) = self.in_use.lock() {
            in_use.remove(&port);
        }
    }

    /// Number of currently-allocated CDP ports.
    #[allow(dead_code)]
    pub fn in_use_count(&self) -> usize {
        self.in_use.lock().map(|s| s.len()).unwrap_or(0)
    }

    /// Total ports this allocator can hand out.
    #[allow(dead_code)]
    pub const fn capacity() -> u16 {
        WEB_CDP_PORT_MAX - WEB_CDP_PORT_MIN + 1
    }
}

/// Thread-safe allocator over the web-session X-display range.
///
/// Holds a `HashSet` of in-use display numbers behind a `Mutex` — fine
/// for the very low contention this allocator sees (acquired once at
/// session start, released once at session end). Concurrency caps are
/// enforced naturally by the range size.
#[derive(Debug, Default)]
pub struct WebDisplayAllocator {
    in_use: Mutex<HashSet<u16>>,
}

impl WebDisplayAllocator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve the next free display number, or return `None` when the
    /// range is exhausted.
    pub fn allocate(&self) -> Option<u16> {
        let mut in_use = self
            .in_use
            .lock()
            .expect("display allocator mutex poisoned");
        (WEB_DISPLAY_MIN..=WEB_DISPLAY_MAX).find(|&n| in_use.insert(n))
    }

    /// Release a previously allocated display number. No-op if the
    /// number was never allocated, so callers can always release in
    /// cleanup paths without checking.
    pub fn release(&self, display: u16) {
        if let Ok(mut in_use) = self.in_use.lock() {
            in_use.remove(&display);
        }
    }

    /// Number of currently-allocated displays. Primarily used by the
    /// `/api/admin/web-sessions/stats` endpoint and by tests.
    pub fn in_use_count(&self) -> usize {
        self.in_use.lock().map(|s| s.len()).unwrap_or(0)
    }

    /// Total number of displays this allocator can hand out.
    pub const fn capacity() -> u16 {
        WEB_DISPLAY_MAX - WEB_DISPLAY_MIN + 1
    }
}

// ─────────────────────────────────────────────────────────────────────
// Connection config (lives in connections.extra JSONB)
// ─────────────────────────────────────────────────────────────────────

/// Typed view of the JSONB blob stored in `connections.extra` for a
/// `web` connection. Built by [`WebSessionConfig::from_extra`] which
/// tolerates missing keys (returning sensible defaults) so existing
/// rdp/ssh/vnc rows that get retyped to `web` upgrade cleanly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebSessionConfig {
    /// Initial URL the Chromium kiosk navigates to.
    pub url: String,

    /// Hostname allow-list passed to Chromium via `--host-rules`. An
    /// empty list disables host-rules entirely (allows any host that
    /// otherwise passes the CIDR check). Hostnames may include `*`
    /// wildcards as understood by Chromium's host-rules syntax.
    #[serde(default)]
    pub allowed_domains: Vec<String>,

    /// Identifier of a registered login script to run after navigation
    /// completes. Scripts are server-side and resolved by name; the
    /// connection only stores the name to keep config rows small and
    /// auditable.
    #[serde(default)]
    pub login_script: Option<String>,
}

impl WebSessionConfig {
    /// Parse a `WebSessionConfig` out of a connection's `extra` JSONB
    /// value. Returns `None` when `url` is missing — every other field
    /// has a usable default.
    pub fn from_extra(extra: &serde_json::Value) -> Option<Self> {
        let obj = extra.as_object()?;
        let url = obj.get("url").and_then(|v| v.as_str())?.trim();
        if url.is_empty() {
            return None;
        }
        let allowed_domains = obj
            .get("allowed_domains")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let login_script = obj
            .get("login_script")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        Some(Self {
            url: url.to_string(),
            allowed_domains,
            login_script,
        })
    }
}

// ─────────────────────────────────────────────────────────────────────
// CIDR egress allow-list
// ─────────────────────────────────────────────────────────────────────

/// Parse a comma-or-newline-separated list of CIDR networks.
///
/// Invalid entries are silently skipped (the calling admin form
/// validates upstream); this is intentionally lenient so a malformed
/// `web_allowed_networks` setting can never panic the request path.
#[allow(dead_code)]
pub fn parse_allowed_networks(raw: &str) -> Vec<IpNet> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<IpNet>().ok())
        .collect()
}

/// Returns `true` when `ip` falls inside any of the supplied networks.
///
/// **Empty `networks` denies everything**, matching rustguac's
/// fail-closed semantics. Operators must explicitly opt in to the
/// public internet (`0.0.0.0/0` and `::/0`) — this is by design so
/// SSRF-style misconfiguration is loud rather than silent.
#[allow(dead_code)]
pub fn is_ip_allowed_by_cidr(ip: IpAddr, networks: &[IpNet]) -> bool {
    networks.iter().any(|n| n.contains(&ip))
}

/// Hostname-level allow-list check. `host` may be a literal IP or a
/// DNS name; for DNS names the caller is responsible for resolution
/// (we deliberately do **not** resolve here so this remains a pure
/// function and so tests don't depend on DNS).
#[allow(dead_code)]
pub fn host_lookup_passes(host: &str, resolved: &[IpAddr], networks: &[IpNet]) -> bool {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_ip_allowed_by_cidr(ip, networks);
    }
    !resolved.is_empty()
        && resolved
            .iter()
            .all(|ip| is_ip_allowed_by_cidr(*ip, networks))
}

/// Extract the host from a URL string for CIDR checking. Returns
/// `None` for unparsable URLs or URLs without a host.
#[allow(dead_code)]
pub fn extract_host(url: &str) -> Option<String> {
    url::Url::parse(url).ok()?.host_str().map(str::to_owned)
}

// ─────────────────────────────────────────────────────────────────────
// Chromium command-line construction
// ─────────────────────────────────────────────────────────────────────

/// Inputs to [`chromium_command_args`]. Kept as a struct so callers can
/// extend without breaking signature.
#[derive(Debug, Clone)]
pub struct ChromiumLaunchSpec<'a> {
    pub url: &'a str,
    pub user_data_dir: &'a std::path::Path,
    /// Allow-listed hostnames. Empty = no `--host-rules` flag emitted.
    pub allowed_domains: &'a [String],
    /// Chrome DevTools Protocol port for login-script automation.
    /// Range typically `9222`–9321`, picked per-session by
    /// [`CdpPortAllocator`].
    pub remote_debugging_port: u16,
    /// True when the backend is running as `root` inside its container.
    /// Mirrors rustguac's `geteuid() == 0` check — Chromium refuses to
    /// run as root without `--no-sandbox`. The default compose stack
    /// runs the backend as root, so this is `true` in production. Set
    /// `false` for hardened deployments running under an unprivileged
    /// uid.
    pub running_as_root: bool,
    /// Initial window width in pixels. Should match the Xvnc
    /// framebuffer width so the kiosk fills the display end-to-end.
    /// Without an explicit `--window-size`, Chromium opens at its
    /// default ~1024×768 inside Xvnc and `--start-fullscreen` does
    /// not stick because there is no window manager to honour the
    /// state change — the user sees Chromium's tab bar and URL bar
    /// floating in the framebuffer.
    pub window_width: u16,
    /// Initial window height in pixels. See `window_width`.
    pub window_height: u16,
}

/// Build the full Chromium kiosk argv mirroring rustguac's invocation.
///
/// Notable flags (rustguac parity items B3–B6):
/// - `--start-fullscreen --noerrdialogs` — borderless full-screen,
///   suppresses Chromium's error dialogs (e.g. "Chrome didn't shut
///   down correctly"). Rustguac chose this over `--kiosk` because some
///   Chromium builds disable kiosk mode under unprivileged systemd.
/// - `--user-data-dir` — ephemeral profile; Strata wipes it on session end.
/// - `--no-first-run` / `--no-default-browser-check` — fully unattended.
/// - `--password-store=basic` — forces the basic OSCrypt path so the
///   Login Data writer in `web_autofill.rs` works without a system
///   keychain.
/// - `--disable-gpu --use-angle=swiftshader` — Xvnc has no GPU; without
///   these the GPU process crashes and triggers Chromium reload loops.
/// - `--disable-features=TranslateUI,VizDisplayCompositor,AutofillServerCommunication`
///   — `VizDisplayCompositor` is the one that matters for Xvnc
///   stability; `AutofillServerCommunication` keeps the kiosk from
///   uploading form fingerprints to Google.
/// - `--no-sandbox` (conditional on `running_as_root`) — required when
///   the backend container runs as root.
/// - `--host-rules="MAP * ~NOTFOUND, MAP <allowed> <allowed>"` — when
///   `allowed_domains` is non-empty, forces every other hostname to
///   resolve to NOTFOUND inside Chromium's resolver. This is rustguac's
///   approach and gives the kiosk a hard wall in addition to the
///   server-side CIDR check.
/// - `--remote-debugging-port=N` bound to localhost only — login
///   automation talks to this over CDP; never exposed off-box.
pub fn chromium_command_args(spec: &ChromiumLaunchSpec<'_>) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--start-fullscreen".into(),
        // rustguac parity — pin the window to the framebuffer corner
        // and size, otherwise Chromium opens at ~1024×768 windowed
        // and `--start-fullscreen` doesn't stick on a bare Xvnc with
        // no window manager.
        format!("--window-position=0,0"),
        format!("--window-size={},{}", spec.window_width, spec.window_height),
        "--noerrdialogs".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-translate".into(),
        // rustguac parity B5 — minimal, kiosk-relevant disable set.
        "--disable-features=TranslateUI,VizDisplayCompositor,AutofillServerCommunication".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-sync".into(),
        "--disable-extensions".into(),
        "--disable-popup-blocking".into(),
        // rustguac parity B4 — Xvnc has no GPU.
        "--disable-gpu".into(),
        "--use-angle=swiftshader".into(),
        "--password-store=basic".into(),
        format!("--user-data-dir={}", spec.user_data_dir.display()),
        format!("--remote-debugging-port={}", spec.remote_debugging_port),
        // CDP must never bind on the public interface — login automation
        // is server-local only.
        "--remote-debugging-address=127.0.0.1".into(),
    ];

    // rustguac parity B6 — `--no-sandbox` is required when running as
    // root; Chromium otherwise refuses to start with `Running as root
    // without --no-sandbox is not supported`.
    if spec.running_as_root {
        args.push("--no-sandbox".into());
    }

    if !spec.allowed_domains.is_empty() {
        let mut rule = String::from("MAP * ~NOTFOUND");
        for domain in spec.allowed_domains {
            // For each allowed host, restore normal resolution by
            // mapping it back to itself.
            rule.push_str(&format!(", MAP {0} {0}", domain));
        }
        args.push(format!("--host-rules={}", rule));
    }

    args.push(spec.url.to_string());
    args
}

// ─────────────────────────────────────────────────────────────────────
// Xvnc spawn argv (rustguac parity B9)
// ─────────────────────────────────────────────────────────────────────

/// Default kiosk geometry. Matches rustguac's default; oversizing is
/// fine because Chromium fills the display and guacd scales on the
/// client. Undersizing causes letterboxing in the operator's browser
/// tab.
pub const WEB_DEFAULT_WIDTH: u16 = 1920;
/// Default kiosk geometry height (paired with [`WEB_DEFAULT_WIDTH`]).
pub const WEB_DEFAULT_HEIGHT: u16 = 1080;

/// Build the argv for spawning a TigerVNC `Xvnc` X server bound to
/// the given display number. Mirrors rustguac's invocation literally.
///
/// Resulting command (when `display = 101`, default geometry):
///
/// ```text
/// Xvnc :101 -geometry 1920x1080 -depth 24 -SecurityTypes None \
///      -AlwaysShared
/// ```
///
/// Flag rationale:
///
/// - `:N` — X display number; pairs with VNC port `5900 + N`.
/// - `-geometry WxH` — initial framebuffer size. Chromium kiosk fills
///   it; operator's RFB client scales.
/// - `-depth 24` — 24-bit colour. 16-bit halves bandwidth but makes
///   anti-aliased text fuzzy.
/// - `-SecurityTypes None` — VNC auth is **off**. The threat model
///   relies on docker network isolation: the kiosk listens on the
///   backend container's interface inside the `guac-internal` bridge
///   network, which is not exposed to the host or the public
///   internet. Only sibling containers on the same compose network
///   (guacd, frontend, vault, postgres) can reach it, and only guacd
///   ever does. Layering VNC password auth on top buys nothing and
///   adds a credential to rotate.
/// - **No `-localhost` flag.** guacd runs in a sibling container, so
///   binding the listener to `127.0.0.1` makes it unreachable. Xvnc's
///   default behaviour (listen on all interfaces) is what we want
///   here — the docker network *is* the security boundary.
/// - `-AlwaysShared` — multiple RFB clients may attach. The Strata
///   reaper sometimes opens a second RFB connection during graceful
///   shutdown to read the final frame for the recording pipeline.
///
/// The first element of the returned vec is the binary name —
/// configurable via `system_settings.web_xvnc_path` — so callers
/// resolve the binary via `which::which` or `Command::new` directly.
pub fn xvnc_command_args(xvnc_path: &str, display: u16, width: u16, height: u16) -> Vec<String> {
    vec![
        xvnc_path.to_string(),
        format!(":{display}"),
        "-geometry".into(),
        format!("{width}x{height}"),
        "-depth".into(),
        "24".into(),
        "-SecurityTypes".into(),
        "None".into(),
        "-AlwaysShared".into(),
    ]
}

/// VNC port = 5900 + display number. Helper to keep the magic
/// constant out of every call site.
pub const fn vnc_port_for_display(display: u16) -> u16 {
    5900 + display
}

// ─────────────────────────────────────────────────────────────────────
// VNC ready poll (rustguac parity B10)
// ─────────────────────────────────────────────────────────────────────

/// Default VNC-readiness deadline. Rustguac uses 2 s flat — Xvnc
/// binds its listener within ~50 ms on every Linux distro tested, so
/// 2 s is generous enough that a slow CI runner doesn't false-fail.
pub const WEB_VNC_READY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

/// Poll `127.0.0.1:{5900+display}` until a TCP connect succeeds or
/// `deadline` elapses. Returns `true` on connect, `false` on timeout.
///
/// Rustguac parity B10 — without this, the spawn-runtime races Xvnc's
/// listener bind. A racy guacd connect manifests as
/// `Connection refused` to the operator and is indistinguishable from
/// a configuration error in the UI.
///
/// Polls every 50 ms (rustguac's interval) so the typical happy path
/// returns within ~100 ms.
pub async fn wait_for_vnc_ready(display: u16, deadline: std::time::Duration) -> bool {
    let port = vnc_port_for_display(display);
    let started = std::time::Instant::now();
    let interval = std::time::Duration::from_millis(50);
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return true;
        }
        if started.elapsed() >= deadline {
            return false;
        }
        tokio::time::sleep(interval).await;
    }
}

// ─────────────────────────────────────────────────────────────────────
// Chromium crash-detect (rustguac parity B11)
// ─────────────────────────────────────────────────────────────────────

/// Default settle window before checking whether Chromium exited
/// immediately. Rustguac uses 500 ms — long enough to surface
/// argv-parse rejections and missing-binary failures, short enough
/// not to delay the operator's first frame.
pub const WEB_CHROMIUM_SETTLE: std::time::Duration = std::time::Duration::from_millis(500);

/// Outcome of [`detect_immediate_chromium_crash`].
#[derive(Debug)]
pub enum ChromiumStartupCheck {
    /// Process is still running after the settle window. This is the
    /// happy path — caller proceeds to hand the VNC endpoint to guacd.
    StillRunning,
    /// Process has already exited. Carries the captured exit status
    /// so callers can log it. Caller should clean up the user-data
    /// dir and surface a `web.session.start` failure audit event.
    Exited(std::process::ExitStatus),
    /// `try_wait` itself errored. The child handle is in an unknown
    /// state; callers should kill it best-effort and treat as crash.
    WaitError(std::io::Error),
}

/// Sleep for `settle`, then poll `child.try_wait()` once. Returns the
/// outcome enum.
///
/// Rustguac parity B11. An immediate exit (within 500 ms) almost
/// always means the argv was wrong (`Xvnc` not running, missing
/// `--user-data-dir` perms, sandbox-without-no-sandbox under root,
/// missing `chromium-sandbox` SUID binary). Without this check the
/// spawn-runtime would hand a dead Chromium's `--remote-debugging-port`
/// to the login-script runner, which would hang on the WebSocket
/// handshake and timeout some 30 s later — a much worse operator UX
/// than a fast-fail audit event.
pub async fn detect_immediate_chromium_crash(
    child: &mut tokio::process::Child,
    settle: std::time::Duration,
) -> ChromiumStartupCheck {
    tokio::time::sleep(settle).await;
    match child.try_wait() {
        Ok(None) => ChromiumStartupCheck::StillRunning,
        Ok(Some(status)) => ChromiumStartupCheck::Exited(status),
        Err(e) => ChromiumStartupCheck::WaitError(e),
    }
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── allocator ────────────────────────────────────────────────
    #[test]
    fn allocator_returns_increasing_displays() {
        let a = WebDisplayAllocator::new();
        let d1 = a.allocate().unwrap();
        let d2 = a.allocate().unwrap();
        assert_eq!(d1, WEB_DISPLAY_MIN);
        assert_eq!(d2, WEB_DISPLAY_MIN + 1);
        assert_eq!(a.in_use_count(), 2);
    }

    #[test]
    fn allocator_reuses_released_displays() {
        let a = WebDisplayAllocator::new();
        let d1 = a.allocate().unwrap();
        let d2 = a.allocate().unwrap();
        a.release(d1);
        let d3 = a.allocate().unwrap();
        assert_eq!(d3, d1, "freed display should be reused");
        assert_eq!(a.in_use_count(), 2);
        a.release(d2);
        a.release(d3);
        assert_eq!(a.in_use_count(), 0);
    }

    #[test]
    fn allocator_returns_none_when_exhausted() {
        let a = WebDisplayAllocator::new();
        let mut handed_out = Vec::new();
        for _ in 0..WebDisplayAllocator::capacity() {
            handed_out.push(a.allocate().expect("range not exhausted yet"));
        }
        assert_eq!(a.allocate(), None);
        assert_eq!(handed_out.len() as u16, WebDisplayAllocator::capacity());
        // All numbers must be unique and within range.
        let unique: HashSet<u16> = handed_out.iter().copied().collect();
        assert_eq!(unique.len(), handed_out.len());
        assert!(handed_out
            .iter()
            .all(|n| (WEB_DISPLAY_MIN..=WEB_DISPLAY_MAX).contains(n)));
    }

    #[test]
    fn allocator_release_unknown_is_noop() {
        let a = WebDisplayAllocator::new();
        a.release(50_000); // never allocated, must not panic
        assert_eq!(a.in_use_count(), 0);
    }

    #[test]
    fn allocator_capacity_matches_range() {
        assert_eq!(WebDisplayAllocator::capacity(), 100);
    }

    // ── config parsing ───────────────────────────────────────────
    #[test]
    fn config_full_extra_round_trip() {
        let extra = serde_json::json!({
            "url": "https://example.com/login",
            "allowed_domains": ["example.com", "*.example.com", ""],
            "login_script": "okta-saml",
        });
        let cfg = WebSessionConfig::from_extra(&extra).unwrap();
        assert_eq!(cfg.url, "https://example.com/login");
        assert_eq!(cfg.allowed_domains, vec!["example.com", "*.example.com"]);
        assert_eq!(cfg.login_script.as_deref(), Some("okta-saml"));
    }

    #[test]
    fn config_minimal_extra_uses_defaults() {
        let extra = serde_json::json!({ "url": "https://example.com" });
        let cfg = WebSessionConfig::from_extra(&extra).unwrap();
        assert_eq!(cfg.allowed_domains, Vec::<String>::new());
        assert_eq!(cfg.login_script, None);
    }

    #[test]
    fn config_missing_url_returns_none() {
        let extra = serde_json::json!({ "allowed_domains": ["example.com"] });
        assert!(WebSessionConfig::from_extra(&extra).is_none());
    }

    #[test]
    fn config_blank_url_returns_none() {
        let extra = serde_json::json!({ "url": "   " });
        assert!(WebSessionConfig::from_extra(&extra).is_none());
    }

    #[test]
    fn config_blank_login_script_normalises_to_none() {
        let extra = serde_json::json!({ "url": "https://example.com", "login_script": "  " });
        let cfg = WebSessionConfig::from_extra(&extra).unwrap();
        assert_eq!(cfg.login_script, None);
    }

    // ── CIDR allow-list ──────────────────────────────────────────
    #[test]
    fn parse_allowed_networks_handles_separators() {
        let raw = "10.0.0.0/8, 192.168.1.0/24\n2001:db8::/32";
        let nets = parse_allowed_networks(raw);
        assert_eq!(nets.len(), 3);
    }

    #[test]
    fn parse_allowed_networks_skips_garbage() {
        let raw = "10.0.0.0/8, not-a-cidr, 999.999.0.0/16, 192.168.0.0/16";
        let nets = parse_allowed_networks(raw);
        assert_eq!(nets.len(), 2);
    }

    #[test]
    fn empty_allow_list_denies_everything() {
        let nets: Vec<IpNet> = vec![];
        assert!(!is_ip_allowed_by_cidr("10.0.0.1".parse().unwrap(), &nets));
        assert!(!is_ip_allowed_by_cidr("8.8.8.8".parse().unwrap(), &nets));
    }

    #[test]
    fn cidr_check_matches_v4_and_v6() {
        let nets = parse_allowed_networks("10.0.0.0/8, 2001:db8::/32");
        assert!(is_ip_allowed_by_cidr("10.5.5.5".parse().unwrap(), &nets));
        assert!(!is_ip_allowed_by_cidr("11.0.0.1".parse().unwrap(), &nets));
        assert!(is_ip_allowed_by_cidr("2001:db8::1".parse().unwrap(), &nets));
        assert!(!is_ip_allowed_by_cidr(
            "2001:dead::1".parse().unwrap(),
            &nets
        ));
    }

    #[test]
    fn host_lookup_literal_ip() {
        let nets = parse_allowed_networks("10.0.0.0/8");
        assert!(host_lookup_passes("10.1.2.3", &[], &nets));
        assert!(!host_lookup_passes("11.1.2.3", &[], &nets));
    }

    #[test]
    fn host_lookup_dns_requires_all_resolved_ips_inside_allow_list() {
        let nets = parse_allowed_networks("10.0.0.0/8");
        let inside: Vec<IpAddr> = vec!["10.1.1.1".parse().unwrap(), "10.2.2.2".parse().unwrap()];
        let mixed: Vec<IpAddr> = vec!["10.1.1.1".parse().unwrap(), "8.8.8.8".parse().unwrap()];
        assert!(host_lookup_passes("intranet.local", &inside, &nets));
        // Even a single off-allow-list resolution must deny — covers
        // DNS-rebinding-style attacks where one of several A records is
        // a public address.
        assert!(!host_lookup_passes("intranet.local", &mixed, &nets));
        assert!(!host_lookup_passes("never-resolved.local", &[], &nets));
    }

    #[test]
    fn extract_host_works() {
        assert_eq!(
            extract_host("https://example.com/login").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            extract_host("http://10.0.0.1:8080/").as_deref(),
            Some("10.0.0.1")
        );
        assert_eq!(extract_host("not a url"), None);
        assert_eq!(extract_host("file:///etc/passwd"), None);
    }

    // ── Chromium argv ────────────────────────────────────────────
    #[test]
    fn chromium_args_contain_kiosk_flags_and_url_last() {
        let dir = std::path::PathBuf::from("/tmp/strata-chromium-abc");
        let spec = ChromiumLaunchSpec {
            url: "https://example.com",
            user_data_dir: &dir,
            allowed_domains: &[],
            remote_debugging_port: 9222,
            running_as_root: false,
            window_width: 1920,
            window_height: 1080,
        };
        let args = chromium_command_args(&spec);
        // rustguac parity B3 — `--start-fullscreen --noerrdialogs`
        // replaces the older `--kiosk` flag.
        assert!(args.contains(&"--start-fullscreen".to_string()));
        assert!(args.contains(&"--noerrdialogs".to_string()));
        assert!(!args.contains(&"--kiosk".to_string()));
        assert!(args.contains(&"--no-first-run".to_string()));
        // Window pinned to framebuffer corner + size so the kiosk
        // fills the display end-to-end on a bare Xvnc with no WM.
        assert!(args.contains(&"--window-position=0,0".to_string()));
        assert!(args.contains(&"--window-size=1920,1080".to_string()));
        // rustguac parity B4 — Xvnc has no GPU.
        assert!(args.contains(&"--disable-gpu".to_string()));
        assert!(args.contains(&"--use-angle=swiftshader".to_string()));
        // rustguac parity B5 — minimal disable set.
        assert!(args.iter().any(|a| a
            == "--disable-features=TranslateUI,VizDisplayCompositor,AutofillServerCommunication"));
        assert!(args
            .iter()
            .any(|a| a == "--user-data-dir=/tmp/strata-chromium-abc"));
        assert!(args.iter().any(|a| a == "--remote-debugging-port=9222"));
        assert!(args
            .iter()
            .any(|a| a == "--remote-debugging-address=127.0.0.1"));
        assert_eq!(args.last().unwrap(), "https://example.com");
    }

    #[test]
    fn chromium_args_omit_no_sandbox_for_unprivileged_runtime() {
        let dir = std::path::PathBuf::from("/tmp/x");
        let spec = ChromiumLaunchSpec {
            url: "https://example.com",
            user_data_dir: &dir,
            allowed_domains: &[],
            remote_debugging_port: 9222,
            running_as_root: false,
            window_width: 1920,
            window_height: 1080,
        };
        let args = chromium_command_args(&spec);
        assert!(!args.contains(&"--no-sandbox".to_string()));
    }

    #[test]
    fn chromium_args_emit_no_sandbox_when_running_as_root() {
        // rustguac parity B6 — Chromium refuses to start as root
        // unless `--no-sandbox` is set.
        let dir = std::path::PathBuf::from("/tmp/x");
        let spec = ChromiumLaunchSpec {
            url: "https://example.com",
            user_data_dir: &dir,
            allowed_domains: &[],
            remote_debugging_port: 9222,
            running_as_root: true,
            window_width: 1920,
            window_height: 1080,
        };
        let args = chromium_command_args(&spec);
        assert!(args.contains(&"--no-sandbox".to_string()));
    }

    #[test]
    fn chromium_args_emit_host_rules_when_allowed_domains_present() {
        let dir = std::path::PathBuf::from("/tmp/x");
        let domains = vec!["example.com".to_string(), "auth.example.com".to_string()];
        let spec = ChromiumLaunchSpec {
            url: "https://example.com",
            user_data_dir: &dir,
            allowed_domains: &domains,
            remote_debugging_port: 9222,
            running_as_root: false,
            window_width: 1920,
            window_height: 1080,
        };
        let args = chromium_command_args(&spec);
        let host_rules = args
            .iter()
            .find(|a| a.starts_with("--host-rules="))
            .expect("expected --host-rules flag");
        assert!(host_rules.contains("MAP * ~NOTFOUND"));
        assert!(host_rules.contains("MAP example.com example.com"));
        assert!(host_rules.contains("MAP auth.example.com auth.example.com"));
    }

    #[test]
    fn chromium_args_omit_host_rules_when_empty() {
        let dir = std::path::PathBuf::from("/tmp/x");
        let spec = ChromiumLaunchSpec {
            url: "https://example.com",
            user_data_dir: &dir,
            allowed_domains: &[],
            remote_debugging_port: 9222,
            running_as_root: false,
            window_width: 1920,
            window_height: 1080,
        };
        let args = chromium_command_args(&spec);
        assert!(!args.iter().any(|a| a.starts_with("--host-rules=")));
    }

    #[test]
    fn chromium_args_window_size_matches_spec() {
        // The kiosk must open at the operator's actual viewport so
        // we don't get black bars on either axis. Default fallback
        // is the WEB_DEFAULT_* constants applied at the caller; the
        // arg builder itself is dumb and uses whatever the spec
        // hands it.
        let dir = std::path::PathBuf::from("/tmp/x");
        let spec = ChromiumLaunchSpec {
            url: "https://example.com",
            user_data_dir: &dir,
            allowed_domains: &[],
            remote_debugging_port: 9222,
            running_as_root: false,
            window_width: 1366,
            window_height: 768,
        };
        let args = chromium_command_args(&spec);
        assert!(args.contains(&"--window-size=1366,768".to_string()));
    }

    // ── CDP port allocator (rustguac parity B2) ─────────────────
    #[test]
    fn cdp_port_allocator_returns_increasing_ports() {
        let a = CdpPortAllocator::new();
        let p1 = a.allocate().unwrap();
        let p2 = a.allocate().unwrap();
        assert_eq!(p1, WEB_CDP_PORT_MIN);
        assert_eq!(p2, WEB_CDP_PORT_MIN + 1);
        assert_eq!(a.in_use_count(), 2);
    }

    #[test]
    fn cdp_port_allocator_reuses_released_ports() {
        let a = CdpPortAllocator::new();
        let p1 = a.allocate().unwrap();
        let _p2 = a.allocate().unwrap();
        a.release(p1);
        let p3 = a.allocate().unwrap();
        assert_eq!(p3, p1);
    }

    #[test]
    fn cdp_port_allocator_returns_none_when_exhausted() {
        let a = CdpPortAllocator::new();
        for _ in 0..CdpPortAllocator::capacity() {
            a.allocate().expect("range not exhausted");
        }
        assert_eq!(a.allocate(), None);
    }

    #[test]
    fn cdp_port_allocator_capacity_matches_display_capacity() {
        // Per-session pairing: one CDP port per display.
        assert_eq!(
            CdpPortAllocator::capacity(),
            WebDisplayAllocator::capacity()
        );
    }

    // ── Xvnc argv (B9) ───────────────────────────────────────────
    #[test]
    fn xvnc_argv_matches_rustguac_shape() {
        // Rustguac parity B9 — argv must literally match the rustguac
        // invocation. A drift here is more dangerous than it looks
        // because TigerVNC silently accepts unknown flags on some
        // builds (Debian) and rejects them on others (Alpine).
        let args = xvnc_command_args("Xvnc", 101, 1920, 1080);
        assert_eq!(
            args,
            vec![
                "Xvnc",
                ":101",
                "-geometry",
                "1920x1080",
                "-depth",
                "24",
                "-SecurityTypes",
                "None",
                "-AlwaysShared",
            ]
        );
    }

    #[test]
    fn xvnc_argv_honours_custom_binary_path() {
        let args = xvnc_command_args("/usr/local/bin/Xvnc", 200, 1280, 720);
        assert_eq!(args[0], "/usr/local/bin/Xvnc");
        assert_eq!(args[1], ":200");
        assert!(args.contains(&"1280x720".to_string()));
    }

    #[test]
    fn xvnc_argv_does_not_bind_localhost() {
        // Critical: guacd runs in a sibling container, so binding
        // Xvnc to `127.0.0.1` would make the kiosk unreachable.
        // The docker network's bridge isolation is the security
        // boundary instead. The test guards against an accidental
        // refactor that re-introduces `-localhost`.
        let args = xvnc_command_args("Xvnc", 100, 800, 600);
        assert!(!args.contains(&"-localhost".to_string()));
    }

    #[test]
    fn vnc_port_helper() {
        assert_eq!(vnc_port_for_display(0), 5900);
        assert_eq!(vnc_port_for_display(100), 6000);
        assert_eq!(vnc_port_for_display(199), 6099);
    }

    // ── VNC ready poll (B10) ─────────────────────────────────────
    #[tokio::test]
    async fn wait_for_vnc_ready_returns_true_when_listener_is_up() {
        // Use port 0 to let the kernel pick — but the function under
        // test polls `5900 + display`, so we have to bind there. Pick
        // a high display number unlikely to collide on the dev host.
        // If the port is taken the test bails (rather than false-passing).
        let display: u16 = 240;
        let port = vnc_port_for_display(display);
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(_) => {
                eprintln!("port {port} busy — skipping wait_for_vnc_ready test");
                return;
            }
        };
        // Spawn a trivial accept loop so connect() succeeds.
        tokio::spawn(async move {
            // Hold the listener open for the test's lifetime.
            let _ = listener.accept().await;
        });
        let ok = wait_for_vnc_ready(display, std::time::Duration::from_secs(2)).await;
        assert!(ok, "expected wait_for_vnc_ready to detect open listener");
    }

    #[tokio::test]
    async fn wait_for_vnc_ready_times_out_when_no_listener() {
        // No bind on display 199's port → poll must time out within
        // the deadline. Use a short deadline so the test stays fast.
        let ok = wait_for_vnc_ready(199, std::time::Duration::from_millis(150)).await;
        assert!(!ok, "expected timeout when no listener present");
    }

    // ── Chromium crash detect (B11) ──────────────────────────────
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_immediate_crash_reports_still_running() {
        // `sleep 5` stays alive past the 200ms settle — must report
        // StillRunning.
        let mut child = tokio::process::Command::new("sleep")
            .arg("5")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleep");
        let outcome =
            detect_immediate_chromium_crash(&mut child, std::time::Duration::from_millis(200))
                .await;
        match outcome {
            ChromiumStartupCheck::StillRunning => {}
            other => panic!("expected StillRunning, got {other:?}"),
        }
        let _ = child.kill().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detect_immediate_crash_reports_exited_for_fast_fail() {
        // `false` exits with status 1 immediately — must report Exited.
        let mut child = tokio::process::Command::new("false")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn false");
        let outcome =
            detect_immediate_chromium_crash(&mut child, std::time::Duration::from_millis(200))
                .await;
        match outcome {
            ChromiumStartupCheck::Exited(status) => assert!(!status.success()),
            other => panic!("expected Exited, got {other:?}"),
        }
    }
}
