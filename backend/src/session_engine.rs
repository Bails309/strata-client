//! Bridge from the WebSocket tunnel to the native Rust session engine.
//!
//! [`run_native`] takes the WebSocket and drives `crates/strata-session`
//! in-process. A protocol the engine cannot serve is refused with the
//! reason (see [`select_native`]) rather than routed elsewhere — there is
//! nowhere else to route it since guacd was removed (ADR-0015).
//!
//! The bridge speaks Guacamole Wire Compatibility Mode, so the browser
//! talks to it exactly as it did to the daemon.
//!
//! ## Environment
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `STRATA_SESSION_NATIVE_PROTOCOLS` | comma-separated protocols the engine may serve; unset means every compiled engine |

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use secrecy::SecretString;
use strata_session::actor::{
    AuditRecord, AuditSink, GuacRecordingSink, NullAuditSink, RecordingPolicy, SessionActor,
    SessionConfig, SessionHandle,
};
use strata_session::engine::keymap::Backspace;
use strata_session::engine::kube::{KubeConfig, KubeEngineFactory};
use strata_session::engine::rdp::layouts::keyboard_layout_id;
use strata_session::engine::rdp::{RdpConfig, RdpEngineFactory, RdpPerformance};
use strata_session::engine::sftp::{SftpConfig, SftpEngine};
use strata_session::engine::ssh::{
    Algorithms, DiscoveredHostKey, HostKeyPolicy, SshConfig, SshEngine,
};
use strata_session::engine::vnc::{
    ClipboardEncoding, VncConfig, VncEngineFactory, DEFAULT_LISTEN_TIMEOUT,
};
use strata_session::engine::{EngineFactory, Protocol, ProtocolEngine, TargetSpec};
use strata_session::protocol::ServerInstruction;
use strata_session::routing::{RoutingPolicy, SessionBackend};
use strata_session::terminal::{
    Palette, RasterisingEngine, TerminalAppearance, TerminalFont, Typescript, DEFAULT_FONT_SIZE_PX,
};
use strata_session::tls::CertPolicy;
use strata_session::transport::{ClientFrame, GuacDecoder, GuacWireEncoder};
use strata_session::wol;
use strata_session::EngineError;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::kerberos_realms;
use crate::tunnel::{HandshakeParams, NvrContext};

/// How often the revocation / duration watchdog runs.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);

/// Hard ceiling on a single session.
const MAX_TUNNEL_DURATION: Duration = Duration::from_secs(8 * 60 * 60);

/// Connection parameter naming the target's accepted host keys.
///
/// SHA-256 fingerprints in OpenSSH's `SHA256:base64` form, comma
/// separated. Without it, and without [`OPENSSH_HOST_KEY_PARAM`], the
/// SSH engine has nothing to verify against and refuses the session.
const HOST_KEY_PARAM: &str = "host-key-fingerprint";

/// Connection parameter holding a full OpenSSH public key.
///
/// Read as a fallback beside [`HOST_KEY_PARAM`] so a connection
/// configured before the engine was rewritten verifies the same host.
pub(crate) const OPENSSH_HOST_KEY_PARAM: &str = "host-key";

/// Connection parameter choosing how an SSH host key is verified:
/// `pinned` (the default), `tofu` or `none`. See [`HostKeyMode`].
pub(crate) const HOST_KEY_POLICY_PARAM: &str = "host-key-policy";

/// Connection parameter offering older SSH algorithms, for network devices.
pub(crate) const LEGACY_ALGORITHMS_PARAM: &str = "ssh-legacy-algorithms";

/// How a connection's SSH host key is verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKeyMode {
    /// Only an approved key is accepted; with none the session is refused.
    Pinned,
    /// The first key seen is pinned; after that it behaves as `Pinned`.
    TrustOnFirstUse,
    /// Any key is accepted, and each one is audited.
    Unverified,
}

impl HostKeyMode {
    /// Read the parameter's value; anything unrecognised fails closed.
    pub(crate) fn from_param(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some(v) if v.eq_ignore_ascii_case("tofu") => Self::TrustOnFirstUse,
            Some(v) if v.eq_ignore_ascii_case("none") => Self::Unverified,
            _ => Self::Pinned,
        }
    }
}

fn host_key_mode(handshake: &HandshakeParams) -> HostKeyMode {
    HostKeyMode::from_param(
        handshake
            .extra
            .get(HOST_KEY_POLICY_PARAM)
            .map(String::as_str),
    )
}

/// The algorithm set a connection's parameter value asks for.
pub(crate) fn ssh_algorithms_from(value: Option<&str>) -> Algorithms {
    if value.is_some_and(|v| matches!(v.trim(), "true" | "1")) {
        Algorithms::Legacy
    } else {
        Algorithms::Modern
    }
}

fn ssh_algorithms(handshake: &HandshakeParams) -> Algorithms {
    ssh_algorithms_from(
        handshake
            .extra
            .get(LEGACY_ALGORITHMS_PARAM)
            .map(String::as_str),
    )
}

/// The host key policy for the session's own SSH connection.
fn session_host_key_policy(handshake: &HandshakeParams) -> HostKeyPolicy {
    let pins = host_key_fingerprints(handshake);
    match host_key_mode(handshake) {
        HostKeyMode::Unverified => HostKeyPolicy::AcceptAny,
        HostKeyMode::TrustOnFirstUse if pins.is_empty() => HostKeyPolicy::AcceptAny,
        _ => HostKeyPolicy::Fingerprints(pins),
    }
}

/// Connection parameter naming the KDC for Kerberos authentication.
///
/// Shared with the guacd path, whose Kerberos patch reads the same key,
/// so a connection already configured for Kerberos works unchanged when
/// routed to the native engine.
const KDC_URL_PARAM: &str = "kdc-url";
const AUTH_PACKAGE_PARAM: &str = "auth-pkg";

/// Connection parameter pinning the target's TLS certificate.
///
/// SHA-256 fingerprints, comma or newline separated, in either the hex
/// form `openssl x509 -fingerprint -sha256` prints or the `SHA256:`
/// base64 form. Named to match guacd's parameter of the same name so a
/// connection configured for one engine means the same on the other.
const CERT_FINGERPRINTS_PARAM: &str = "cert-fingerprints";

/// Upper bound on `scrollback`, which the server holds in memory for the
/// life of the session.
const MAX_SCROLLBACK_LINES: usize = 100_000;

/// The PEM of the connection's attached trusted-CA bundle.
///
/// Not an administrator-facing parameter: the connection stores a
/// `trusted_ca_id`, and the tunnel route resolves it to this before the
/// handshake is built, the same way the web kiosk resolves it before
/// spawning Chromium. Absent from the guacd allowlist, so it is never
/// forwarded on the wire.
pub(crate) const TRUSTED_CA_PEM_PARAM: &str = "trusted-ca-pem";

/// Connection parameters naming a feature the native RDP engine does
/// not implement at all.
///
/// guacd does implement these, so a connection asking for one is routed
/// there instead. Running it natively would drop a setting an
/// administrator deliberately chose, and a redirected drive or printer
/// that silently fails to appear is worse than a slower session.
/// SSH parameters that cost only fidelity.
///
/// The terminal's appearance is decided by the client, which renders it,
/// so guacd's font and colour parameters have nothing to act on here.
const SSH_PARAMS_IGNORED_NATIVELY: &[&str] = &[
    // Agent forwarding, deliberately not implemented: forwarding an
    // agent lets anyone with root on the target authenticate as the
    // operator elsewhere, which is the opposite of what a privileged
    // access gateway is for. This guacd does not advertise the parameter
    // either, so routing to it would decline the request just as loudly
    // and cost the native engine as well.
    "enable-agent",
    "locale",
    "font-name",
];

/// Read the connection's clipboard encoding.
///
/// UTF-16, CP1252 and MacRoman cannot be produced: `CopyText` takes a
/// `String`, so every byte the engine writes is valid UTF-8 by
/// construction. They fall back to the RFB default with a warning rather
/// than failing the connection, which is what guacd does with a value it
/// does not recognise.
fn clipboard_encoding(handshake: &HandshakeParams) -> ClipboardEncoding {
    match handshake.extra.get("clipboard-encoding").map(|e| e.trim()) {
        Some("UTF-8") => ClipboardEncoding::Utf8,
        Some(other) if !other.is_empty() && other != "ISO8859-1" => {
            tracing::warn!(
                encoding = %other,
                "native vnc engine cannot produce this clipboard encoding; \
                 using ISO8859-1, the RFB default"
            );
            ClipboardEncoding::Latin1
        }
        _ => ClipboardEncoding::Latin1,
    }
}

/// VNC parameters that cost only fidelity.
///
/// Encoding and quality settings tune a negotiation the engine already
/// makes for itself: it asks for Tight, ZRLE, TRLE, `CopyRect` and Raw and
/// takes whichever the server picks.
const VNC_PARAMS_IGNORED_NATIVELY: &[&str] = &[
    // Audio would arrive over a separate PulseAudio connection rather
    // than over RFB. guacd does implement it, but nothing in this
    // deployment runs a PulseAudio server for it to read from.
    "enable-audio",
    "audio-servername",
    "color-depth",
    "swap-red-blue",
    "cursor",
    "encodings",
    "compress-level",
    "quality-level",
    "autoretry",
    "force-lossless",
];

/// Kubernetes parameters that cost only fidelity.
///
/// The terminal is drawn by the client, and the exec API has no say in
/// how it looks.
const KUBE_PARAMS_IGNORED_NATIVELY: &[&str] = &["font-name", "terminal-type"];

/// Parameters that cost only fidelity.
///
/// The session still works, so these are not worth giving up the native
/// engine over — but an administrator who set one should be able to
/// find out why it made no difference.
/// Parameters that cost only fidelity.
///
/// The session still works, so these are not worth giving up the native
/// engine over — but an administrator who set one should be able to
/// find out why it made no difference.
///
/// `force-lossless` is absent because the encoder only ever emits PNG,
/// so the connection already gets what it asked for.
const RDP_PARAMS_IGNORED_NATIVELY: &[&str] = &["timezone", "enable-touch"];

/// Whether a parameter is set to something meaningful.
fn is_set(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value != "false" && value != "0"
}

/// Which of `keys` this connection actually sets.
fn params_in_use<'a>(handshake: &HandshakeParams, keys: &[&'a str]) -> Vec<&'a str> {
    keys.iter()
        .copied()
        .filter(|key| handshake.extra.get(*key).is_some_and(|v| is_set(v)))
        .collect()
}

/// Warn about admin-configured parameters this engine will not honour.
fn warn_ignored_params(handshake: &HandshakeParams, keys: &[&str], protocol: &str) {
    let ignored = params_in_use(handshake, keys);
    if !ignored.is_empty() {
        tracing::warn!(
            %protocol,
            params = ?ignored,
            "native engine ignores these connection parameters; \
             the session runs but does not honour them"
        );
    }
}

/// Warn about admin-configured parameters this engine will not honour.
fn warn_unsupported_rdp_params(handshake: &HandshakeParams) {
    let ignored = params_in_use(handshake, RDP_PARAMS_IGNORED_NATIVELY);
    if !ignored.is_empty() {
        tracing::warn!(
            params = ?ignored,
            "native rdp engine ignores these connection parameters; \
             the session works but will not match how it is configured"
        );
    }
    // `display-update` is what the engine does: the Display Control
    // channel is always attached, so the desktop follows the browser
    // window. Only the reconnect strategy is unimplemented, and warning
    // about the one we do implement would be noise.
    if handshake
        .extra
        .get("resize-method")
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("reconnect"))
    {
        tracing::warn!(
            "connection asks for resize-method=reconnect; the native engine resizes over the \
             Display Control channel instead, which does not drop the session"
        );
    }
    // A gateway must fail closed when the target will not do NLA, so the
    // engine advertises CredSSP alone. Anything else the connection asks
    // for is refused rather than silently downgraded, and an operator who
    // set it should be able to find out why.
    if let Some(requested) = handshake
        .security
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("nla"))
    {
        tracing::warn!(
            requested,
            "connection asks for a non-NLA rdp security layer; the native engine only \
             negotiates CredSSP, so the session fails rather than downgrading"
        );
    }
}

/// Read a checkbox-style parameter using guacd's truthiness rules.
fn flag(handshake: &HandshakeParams, key: &str) -> bool {
    handshake
        .extra
        .get(key)
        .is_some_and(|v| matches!(v.trim(), "true" | "1"))
}

/// Read a checkbox-style parameter that is not off when absent.
///
/// [`crate::tunnel::HandshakeParams::full_param_map`] fills in defaults
/// before guacd sees a connection, so an unset parameter does not mean the
/// same thing on the two paths. Reading `extra` raw here made the native
/// engine disable ClearType on every connection that had never set it,
/// while guacd was being told to enable it — the two engines rendered the
/// same desktop differently for no reason an administrator could see.
fn flag_or(handshake: &HandshakeParams, key: &str, default: bool) -> bool {
    handshake
        .extra
        .get(key)
        .map_or(default, |v| matches!(v.trim(), "true" | "1"))
}

/// What the BackSpace key sends, from the connection's `backspace`.
///
/// An unrecognised value keeps DEL rather than guessing: guacd names
/// exactly the two code points, so anything else is a typo, and the
/// wrong choice here breaks line editing on every session.
fn backspace(handshake: &HandshakeParams) -> Backspace {
    handshake
        .extra
        .get("backspace")
        .and_then(|raw| Backspace::from_param(raw))
        .unwrap_or_default()
}

/// Layout id and whether to type Unicode, from `server-layout`.
///
/// Characters are typed on this layout, so it has to match the target
/// user's own; a mismatch moves symbols (`\` arriving as `#`). Blank means
/// UK English, which is what this estate's targets use. `failsafe` and
/// names with no bundled keymap send Unicode events instead, which console
/// line editors such as PSReadLine on Server Core ignore.
fn rdp_keyboard(handshake: &HandshakeParams) -> (u32, bool) {
    const DEFAULT_LAYOUT: u32 = 0x0809;
    let name = handshake
        .extra
        .get("server-layout")
        .map(|n| n.trim())
        .filter(|n| !n.is_empty());
    let Some(name) = name else {
        return (DEFAULT_LAYOUT, false);
    };
    if let Some(id) = keyboard_layout_id(name) {
        return (id, false);
    }
    if !name.eq_ignore_ascii_case("failsafe") {
        tracing::warn!(
            layout = name,
            "unknown server-layout; sending Unicode key events"
        );
    }
    (DEFAULT_LAYOUT, true)
}

/// Bits per pixel to request, from the connection's `color-depth`.
///
/// Only the four depths guacd offers are accepted; anything else keeps
/// the default, because a value the server rejects costs the session.
fn color_depth(handshake: &HandshakeParams) -> Option<u32> {
    handshake
        .extra
        .get("color-depth")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|d| matches!(d, 8 | 16 | 24 | 32))
}

/// Terminal appearance, from the connection's `color-scheme` and
/// `scrollback` parameters.
///
/// An unrecognised scheme keeps the default rather than guessing, and
/// says so — guacd names exactly four, so anything else is a typo.
fn terminal_appearance(handshake: &HandshakeParams) -> TerminalAppearance {
    let mut appearance = TerminalAppearance::default();

    if let Some(raw) = handshake.extra.get("color-scheme").map(|s| s.trim()) {
        if !raw.is_empty() {
            match Palette::from_scheme(raw) {
                Some(palette) => appearance.palette = palette,
                None => tracing::warn!(
                    scheme = raw,
                    "unknown color-scheme; the terminal keeps its default colours"
                ),
            }
        }
    }

    if let Some(lines) = handshake
        .extra
        .get("scrollback")
        .and_then(|v| v.trim().parse::<usize>().ok())
    {
        // Clamped: the history is held per session, so an unbounded
        // value here is a memory cost paid by the server.
        appearance.scrollback = lines.min(MAX_SCROLLBACK_LINES);
    }

    appearance
}

/// Terminal glyph size in pixels, from the connection's `font-size`.
///
/// guacd takes points and renders at 96 DPI; the rasteriser takes pixels
/// directly, so the conversion is the same 4/3 ratio a browser uses.
/// Clamped rather than rejected: an out-of-range value should not cost
/// the session, and a terminal nobody can read is not an improvement.
fn terminal_font_size(handshake: &HandshakeParams) -> f32 {
    const MIN_PX: f32 = 8.0;
    const MAX_PX: f32 = 72.0;

    handshake
        .extra
        .get("font-size")
        .and_then(|v| v.trim().parse::<f32>().ok())
        .filter(|pt| pt.is_finite() && *pt > 0.0)
        .map_or(DEFAULT_FONT_SIZE_PX, |pt| {
            (pt * 4.0 / 3.0).clamp(MIN_PX, MAX_PX)
        })
}

/// The process-wide rollout policy, read from the environment once.
pub fn policy() -> &'static RoutingPolicy {
    static POLICY: OnceLock<RoutingPolicy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let policy = policy_from_env();
        tracing::info!(?policy, "native session engine routing policy");
        policy
    })
}

static SHUTDOWN: OnceLock<tokio_util::sync::CancellationToken> = OnceLock::new();

/// Hand the process shutdown signal to the native session loop.
///
/// Without it a restart looks to the browser like the *target* hung up,
/// which is a deliberate end of session and suppresses its automatic
/// reconnect. guacd never had the problem: it holds the target
/// connection in its own process, so restarting this one simply dropped
/// the socket.
pub fn set_shutdown_token(token: tokio_util::sync::CancellationToken) {
    let _ = SHUTDOWN.set(token);
}

/// A token that is never cancelled when none was installed, so tests and
/// embedded uses behave as before.
fn shutdown_token() -> tokio_util::sync::CancellationToken {
    SHUTDOWN.get().cloned().unwrap_or_default()
}

fn policy_from_env() -> RoutingPolicy {
    let available = RoutingPolicy::compiled_protocols();
    let eligible = eligible_protocols(
        std::env::var("STRATA_SESSION_NATIVE_PROTOCOLS")
            .ok()
            .as_deref(),
        &available,
    );

    RoutingPolicy::new(available).with_eligible_protocols(eligible)
}

/// Which protocols this deployment may serve.
///
/// A blank value counts as unset. Compose passes the variable through as
/// `${STRATA_SESSION_NATIVE_PROTOCOLS:-}`, so commenting the line out in
/// `.env` still delivers an empty string — and reading that literally
/// would leave nothing eligible, refusing every session rather than
/// serving them all.
fn eligible_protocols(raw: Option<&str>, available: &HashSet<Protocol>) -> HashSet<Protocol> {
    let entries: Vec<&str> = raw
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .collect();
    // Naming nothing is not the same as naming something unrecognised:
    // an empty list is the operator having expressed no restriction.
    if entries.is_empty() {
        return available.clone();
    }
    let mut eligible = HashSet::new();
    for entry in entries {
        match protocol_from_str(entry) {
            Some(protocol) => {
                eligible.insert(protocol);
            }
            // Named but unrecognised: honour the restriction, because
            // ignoring it would serve more than was asked for, but say
            // so — a typo here silently drops a protocol.
            None => tracing::warn!(
                entry,
                "STRATA_SESSION_NATIVE_PROTOCOLS names an unknown protocol; ignoring it"
            ),
        }
    }
    eligible
}

/// What the session engine can serve, for the admin health page.
#[derive(serde::Serialize)]
pub struct EngineHealth {
    /// Protocols this deployment will serve, sorted.
    pub protocols: Vec<&'static str>,
    /// Protocols compiled in but held back by configuration.
    pub withheld: Vec<&'static str>,
    /// Whether the terminal rasteriser can find a font. SSH and
    /// Kubernetes sessions are refused without one, so this is the only
    /// part of the engine that can be unhealthy rather than merely off.
    pub terminal_font: bool,
}

/// Report what the engine is able to serve right now.
pub fn engine_health() -> EngineHealth {
    fn name(protocol: Protocol) -> &'static str {
        match protocol {
            Protocol::Ssh => "ssh",
            Protocol::Rdp => "rdp",
            Protocol::Vnc => "vnc",
            Protocol::KubeExec => "kubernetes",
        }
    }

    let policy = policy();
    let mut protocols: Vec<&'static str> = policy
        .available()
        .intersection(policy.eligible())
        .copied()
        .map(name)
        .collect();
    protocols.sort_unstable();

    let mut withheld: Vec<&'static str> = policy
        .available()
        .iter()
        .filter(|p| !policy.eligible().contains(p))
        .map(|p| name(*p))
        .collect();
    withheld.sort_unstable();

    EngineHealth {
        protocols,
        withheld,
        terminal_font: TerminalFont::discover(DEFAULT_FONT_SIZE_PX).is_ok(),
    }
}

/// Map a connection's protocol column onto the engine's protocol enum.
pub fn protocol_from_str(protocol: &str) -> Option<Protocol> {
    match protocol.trim().to_ascii_lowercase().as_str() {
        "ssh" => Some(Protocol::Ssh),
        "rdp" => Some(Protocol::Rdp),
        "vnc" => Some(Protocol::Vnc),
        "kubernetes" => Some(Protocol::KubeExec),
        _ => None,
    }
}

/// Decide whether the engine can serve this session.
///
/// Returns `None` when it cannot, which refuses the session. Every
/// `None` is logged with the reason, because it is now a failure the
/// operator has to be able to explain rather than a quiet fallback.
pub fn select_native(handshake: &HandshakeParams) -> Option<Protocol> {
    let Some(protocol) = protocol_from_str(&handshake.protocol) else {
        tracing::warn!(
            host = %handshake.hostname,
            protocol = %handshake.protocol,
            "no engine serves this protocol"
        );
        return None;
    };
    let decision = policy().decide(protocol);
    if decision.backend != SessionBackend::Native {
        tracing::warn!(
            host = %handshake.hostname,
            protocol = %handshake.protocol,
            reason = decision.reason,
            "refusing session"
        );
        return None;
    }

    if let Err(reason) = preflight(protocol, handshake) {
        tracing::warn!(
            host = %handshake.hostname,
            protocol = %handshake.protocol,
            %reason,
            "session cannot run on this engine"
        );
        return None;
    }

    tracing::info!(
        host = %handshake.hostname,
        protocol = %handshake.protocol,
        "starting session"
    );
    Some(protocol)
}

/// Apply global Kerberos realm settings to an auto-detect RDP connection.
pub async fn resolve_global_kdc(
    handshake: &mut HandshakeParams,
    pool: Option<&sqlx::Pool<sqlx::Postgres>>,
) {
    if !handshake.protocol.eq_ignore_ascii_case("rdp")
        || kdc_url(handshake).is_some()
        || handshake
            .extra
            .get(AUTH_PACKAGE_PARAM)
            .is_some_and(|value| value.eq_ignore_ascii_case("ntlm"))
    {
        return;
    }

    let (Some(pool), Some(domain)) = (pool, handshake.domain.as_deref()) else {
        return;
    };

    match kerberos_realms::find_for_domain(pool, domain).await {
        Ok(Some(realm)) => {
            if let Some(kdc) = realm
                .kdc_servers
                .split(',')
                .map(str::trim)
                .find_map(normalise_kdc)
            {
                handshake
                    .extra
                    .insert(KDC_URL_PARAM.to_owned(), kdc.clone());
                tracing::info!(realm = %realm.realm, %kdc, "resolved RDP KDC from global realm");
            }
        }
        Ok(None) => {}
        Err(err) => {
            tracing::warn!(error = %err, %domain, "failed to resolve global Kerberos realm")
        }
    }
}

/// Everything that must be true before a session can run natively.
fn preflight(protocol: Protocol, handshake: &HandshakeParams) -> Result<(), String> {
    // Applies to every protocol: file transfer dials its own SSH
    // connection, and the native engines do not connect to a host
    // nobody has verified.
    if flag(handshake, "enable-sftp")
        && sftp_config(handshake).is_none_or(|c| c.host_keys.is_empty())
    {
        return Err(
            "connection enables SFTP but pins no host key for it; set `sftp-host-key`, \
             or use the same host as the session so its key applies"
                .to_owned(),
        );
    }
    match protocol {
        Protocol::Ssh => {
            if host_key_mode(handshake) == HostKeyMode::Pinned
                && host_key_fingerprints(handshake).is_empty()
            {
                return Err(format!(
                    "connection pins no host key (`{OPENSSH_HOST_KEY_PARAM}` or \
                     `{HOST_KEY_PARAM}`) and requires one; approve the key with Fetch from \
                     server, or set host key verification to trust on first use"
                ));
            }
            // Only SSH needs the rasteriser, and only in wire mode.
            TerminalFont::discover(terminal_font_size(handshake)).map_err(|e| e.to_string())?;
            Ok(())
        }
        Protocol::Rdp => {
            // Nothing about an RDP session needs guacd now. Audio
            // playback is carried over RDPSND, so a connection that
            // allows it no longer has to leave the native engine.
            //
            // Checked here as well as at connect time so a mistyped
            // fingerprint is reported before the target is dialled,
            // where the message is about the connection rather than
            // about a handshake that failed.
            rdp_cert_policy(handshake)?;
            let kerberos_only = handshake
                .extra
                .get(AUTH_PACKAGE_PARAM)
                .is_some_and(|value| value.eq_ignore_ascii_case("kerberos"));
            if kerberos_only && kdc_url(handshake).is_none() {
                return Err(format!(
                    "Kerberos-only RDP requires a `{KDC_URL_PARAM}` parameter for the native engine"
                ));
            }
            Ok(())
        }
        Protocol::Vnc => {
            // The engine speaks the two security types in the RFB spec:
            // none, and the DES password challenge. Neither carries a
            // username, so one being set means the server wants UltraVNC
            // MS-Logon or VeNCrypt, and a login the administrator
            // configured would simply be dropped.
            if handshake
                .username
                .as_deref()
                .is_some_and(|u| !u.trim().is_empty())
            {
                return Err(
                    "connection sets a username, and the native VNC engine implements only \
                     the password security types from the RFB specification"
                        .to_owned(),
                );
            }
            Ok(())
        }
        Protocol::KubeExec => {
            // Nothing about a Kubernetes exec session needs guacd now.
            // Without a pod there is nothing to attach to, and the API
            // server would answer with a 404 the operator cannot read.
            if !handshake.extra.get("pod").is_some_and(|p| is_set(p)) {
                return Err(
                    "connection has no `pod` parameter, so there is nothing to attach to"
                        .to_owned(),
                );
            }
            // Only the terminal engines need the rasteriser.
            TerminalFont::discover(terminal_font_size(handshake)).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

/// Read fingerprints from a parameter holding either `SHA256:` values or
/// OpenSSH public keys.
fn fingerprints_from(raw: &str) -> Vec<String> {
    let explicit: Vec<String> = raw
        .split(',')
        .map(|f| f.trim().to_owned())
        .filter(|f| f.starts_with("SHA256:"))
        .collect();
    if !explicit.is_empty() {
        return explicit;
    }
    raw.lines()
        .flat_map(|line| line.split(','))
        .filter_map(fingerprint_openssh_key)
        .collect()
}

fn host_key_fingerprints(handshake: &HandshakeParams) -> Vec<String> {
    let explicit = handshake
        .extra
        .get(HOST_KEY_PARAM)
        .map(|raw| {
            raw.split(',')
                .map(|f| f.trim().to_owned())
                .filter(|f| !f.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !explicit.is_empty() {
        return explicit;
    }

    // Fall back to the full OpenSSH key an administrator can paste. There
    // is no way to produce a SHA256 fingerprint from the admin panel, and
    // requiring one would mean every existing SSH connection had to be
    // re-entered before it could run natively.
    //
    // Several keys may be listed: a host usually offers more than one
    // type and which is used comes out of negotiation, so pinning only
    // the first would fail whenever the other was chosen.
    handshake
        .extra
        .get(OPENSSH_HOST_KEY_PARAM)
        .map(|raw| {
            raw.lines()
                .flat_map(|line| line.split(','))
                .filter_map(fingerprint_openssh_key)
                .collect()
        })
        .unwrap_or_default()
}

/// Derive the `SHA256:` fingerprint of an OpenSSH public key.
///
/// The fingerprint covers the base64 key blob, which is the middle field
/// of `<type> <blob> <comment>`. Returns `None` rather than a wrong
/// fingerprint for anything that does not parse, so a malformed entry
/// fails preflight and the session stays on guacd instead of connecting
/// to a host nobody verified.
pub(crate) fn fingerprint_openssh_key(key: &str) -> Option<String> {
    use base64::Engine as _;
    use sha2::Digest as _;

    let blob = key.split_whitespace().find_map(|field| {
        base64::engine::general_purpose::STANDARD
            .decode(field)
            .ok()
            .filter(|decoded| decoded.len() > 4)
    })?;
    let digest = sha2::Sha256::digest(&blob);
    Some(format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    ))
}

/// Normalise a KDC address into a URL both engines accept.
///
/// A bare hostname is what an administrator naturally types, and what
/// the realm table stores, but guacd hands the value straight to
/// FreeRDP's `KerberosKdcUrl` without touching it. Normalising once, at
/// the point of discovery, keeps the two engines from disagreeing about
/// what the same connection means.
fn normalise_kdc(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        None
    } else if value.contains("://") {
        Some(value.to_owned())
    } else {
        Some(format!("tcp://{value}:88"))
    }
}

fn kdc_url(handshake: &HandshakeParams) -> Option<String> {
    handshake
        .extra
        .get(KDC_URL_PARAM)
        .and_then(|raw| normalise_kdc(raw))
}

/// What the connection accepts from the RDP target's TLS certificate.
///
/// The precedence is deliberate. A pinned fingerprint and an attached CA
/// are both specific statements about *this* target, so either outranks
/// the blanket "ignore certificate" box — an administrator who pinned a
/// fingerprint and left that box ticked from an earlier troubleshooting
/// session gets the pin enforced rather than discarded. A connection
/// with neither behaves exactly as it did before this existed.
fn rdp_cert_policy(handshake: &HandshakeParams) -> Result<CertPolicy, String> {
    let fingerprints = cert_fingerprints(handshake)?;
    if !fingerprints.is_empty() {
        return Ok(CertPolicy::Pinned { fingerprints });
    }
    let bundle = handshake
        .extra
        .get(TRUSTED_CA_PEM_PARAM)
        .map(|p| p.trim())
        .filter(|p| !p.is_empty());
    match bundle {
        Some(pem) => Ok(CertPolicy::Verify {
            extra_roots: Some(pem.to_owned()),
        }),
        None if handshake.ignore_cert => Ok(CertPolicy::Ignore),
        None => Ok(CertPolicy::Verify { extra_roots: None }),
    }
}

/// Parse the pinned certificate fingerprints, rejecting malformed ones.
///
/// A fingerprint that cannot be parsed is an error rather than a skipped
/// entry: dropping it would leave the remaining pins looking like the
/// whole list, so a typo would quietly narrow what the connection
/// accepts instead of failing where it can be corrected.
fn cert_fingerprints(handshake: &HandshakeParams) -> Result<Vec<Vec<u8>>, String> {
    let Some(raw) = handshake.extra.get(CERT_FINGERPRINTS_PARAM) else {
        return Ok(Vec::new());
    };
    raw.lines()
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            strata_session::tls::parse_fingerprint(entry).ok_or_else(|| {
                format!(
                    "`{CERT_FINGERPRINTS_PARAM}` contains `{entry}`, which is not a SHA-256 \
                     certificate fingerprint; expected 64 hex characters or a `SHA256:` value"
                )
            })
        })
        .collect()
}

/// Serve one session with the native engine.
///
/// Deliberately mirrors every concurrent concern of the `guacd` loop in
/// [`crate::tunnel`] — recording, live observation, admin kill, the
/// revocation watchdog and shared input. A session must not lose its
/// audit trail just because it was routed to the new engine.
#[allow(clippy::too_many_arguments)]
pub async fn run_native(
    mut ws: WebSocket,
    handshake: HandshakeParams,
    protocol: Protocol,
    nvr: Option<NvrContext>,
    watchdog_token: Option<String>,
    user_id: Uuid,
) -> Result<(), AppError> {
    // Storage before the target: a session that must be recorded never
    // reaches the target unless its recording is open.
    let (audit, fault) = match open_recording(&handshake).await {
        Ok(opened) => opened,
        Err(e) => {
            recording_failed(nvr.as_ref(), &handshake, user_id, "open", &e.to_string()).await;
            if handshake.recording_required {
                refuse(
                    &mut ws,
                    "This connection must be recorded, and the recording could not be started. Contact your administrator.",
                    SERVER_ERROR,
                )
                .await;
                return Err(e);
            }
            (Box::new(NullAuditSink) as Box<dyn AuditSink>, None)
        }
    };
    let engine = match connect_engine(protocol, &handshake).await {
        Ok((engine, presented)) => {
            if let (Some(ctx), Some(key)) = (nvr.as_ref(), presented.as_ref()) {
                record_host_key(ctx, &handshake, user_id, key).await;
            }
            engine
        }
        Err(e) => {
            // Without a reason the browser takes the close for a network
            // drop and retries, and every retry is another failed sign-in.
            let (notice, status) = e.notice();
            refuse(&mut ws, notice, status).await;
            let e = AppError::from(e);
            mark_recording(
                nvr.as_ref(),
                &handshake,
                "failed",
                &format!("the session did not connect: {e}"),
            )
            .await;
            return Err(e);
        }
    };

    let session_id = nvr
        .as_ref()
        .map(|ctx| ctx.session_id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // Register before the first frame so an observer attaching early
    // cannot miss the layer-size instruction.
    let mut broadcast = None;
    let mut buffer = None;
    let mut kill_rx = None;
    let mut shared_input_rx = None;
    let mut bandwidth = None;
    if let Some(ctx) = nvr.as_ref() {
        match ctx
            .registry
            .register(
                ctx.session_id.clone(),
                ctx.connection_id,
                ctx.connection_name.clone(),
                ctx.protocol.clone(),
                ctx.user_id,
                ctx.username.clone(),
                handshake.hostname.clone(),
                ctx.client_ip.clone(),
            )
            .await
        {
            Some((tx, buf, kill, input)) => {
                broadcast = Some(tx);
                buffer = Some(buf);
                kill_rx = Some(kill);
                shared_input_rx = Some(input);
                bandwidth = ctx.registry.get(&ctx.session_id).await;
            }
            None => {
                tracing::error!("Session limit reached — rejecting native tunnel");
                mark_recording(nvr.as_ref(), &handshake, "failed", "session limit reached").await;
                refuse(
                    &mut ws,
                    "Strata is running as many sessions as it allows. Try again in a few minutes.",
                    CLIENT_TOO_MANY,
                )
                .await;
                return Err(AppError::Internal(
                    "Maximum concurrent session limit reached".into(),
                ));
            }
        }
    }

    let (handle, mut frames) = SessionActor::spawn(SessionConfig {
        id: session_id,
        engine,
        encoder: Box::new(GuacWireEncoder::new()),
        audit,
        recording: RecordingPolicy {
            exclude_output: flag(&handshake, "recording-exclude-output"),
            include_keys: flag(&handshake, "recording-include-keys"),
        },
        moderator: None,
        credential: None,
    });

    let (mut sink, mut stream) = ws.split();
    let mut decoder = GuacDecoder::default();

    let mut watchdog = tokio::time::interval(WATCHDOG_INTERVAL);
    watchdog.tick().await; // consume the immediate first tick
    let started_at = tokio::time::Instant::now();
    let opened_at = chrono::Utc::now();
    let shutdown = shutdown_token();

    let reason = loop {
        tokio::select! {
            // Gateway shutdown. Drop the socket rather than sending a
            // disconnect: the engine is about to read EOF from the
            // target and report it as a deliberate close, which stops
            // the browser retrying. An abrupt close is the truth here,
            // and is what the browser retries on.
            _ = shutdown.cancelled() => {
                break "gateway shutting down";
            }

            // Administrative kill signal.
            _ = async {
                match kill_rx {
                    Some(ref mut rx) => rx.await.ok(),
                    None => std::future::pending().await,
                }
            } => {
                send_error(&mut sink, "Session terminated by administrator", SESSION_CONFLICT).await;
                break "terminated by administrator";
            }

            _ = watchdog.tick() => {
                let mut verdict = watchdog_verdict(watchdog_token.as_deref(), started_at);
                if verdict.is_none() {
                    if let Some(ctx) = nvr.as_ref() {
                        // A database hiccup must not drop a live session.
                        let valid = crate::services::users::session_still_valid(
                            &ctx.db_pool,
                            user_id,
                            opened_at,
                        )
                        .await
                        .unwrap_or(true);
                        if !valid {
                            verdict = Some(WatchdogVerdict {
                                client: "This session was closed because your account was signed out.",
                                audit: "account_signed_out",
                            });
                        }
                    }
                }
                if let Some(reason) = verdict {
                    if let Some(ctx) = nvr.as_ref() {
                        let _ = crate::services::audit::log(
                            &ctx.db_pool,
                            Some(user_id),
                            "tunnel.watchdog_closed",
                            &serde_json::json!({
                                "connection_id": ctx.connection_id.to_string(),
                                "reason": reason.audit,
                                "engine": "native",
                            }),
                        )
                        .await;
                    }
                    send_error(&mut sink, reason.client, SESSION_CLOSED).await;
                    break reason.audit;
                }
            }

            frame = frames.recv() => {
                let Some(frame) = frame else {
                    break "session ended";
                };
                let message = match &frame {
                    ClientFrame::Text(bytes) => {
                        let Ok(text) = std::str::from_utf8(bytes) else {
                            break "engine emitted invalid utf-8";
                        };
                        let shared = Arc::new(text.to_owned());
                        // Observers and the ring buffer see exactly what
                        // the operator sees.
                        if let Some(buf) = buffer.as_ref() {
                            buf.write().await.push(shared.as_ref().clone());
                        }
                        if let Some(tx) = broadcast.as_ref() {
                            let _ = tx.send(Arc::clone(&shared));
                        }
                        Message::Text(shared.as_str().into())
                    }
                    ClientFrame::Binary(bytes) => Message::Binary(bytes.clone()),
                };
                if let Some(sess) = bandwidth.as_ref() {
                    sess.bytes_down
                        .fetch_add(frame.len() as u64, Ordering::Relaxed);
                }
                if sink.send(message).await.is_err() {
                    break "client socket closed";
                }
            }

            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(sess) = bandwidth.as_ref() {
                            sess.bytes_up
                                .fetch_add(text.len() as u64, Ordering::Relaxed);
                        }
                        decoder.extend(text.as_bytes());
                        if let Err(why) = forward_instructions(&mut decoder, &handle).await {
                            break why;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break "client closed the socket";
                    }
                    Some(Err(err)) => {
                        tracing::debug!(error = %err, "client websocket error");
                        break "client socket error";
                    }
                    // Pings, pongs and stray binary frames carry nothing
                    // the Guacamole protocol needs.
                    Some(Ok(_)) => {}
                }
            }

            // Input injected by an authorised viewer (multiviewer / co-pilot).
            Some(injected) = async {
                match shared_input_rx {
                    Some(ref mut rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                if forward_guest_instructions(&injected, &handle).await.is_err() {
                    break "session ended";
                }
            }
        }
    };

    let duration_secs = started_at.elapsed().as_secs();
    match nvr.as_ref() {
        Some(ctx) => tracing::info!(
            %reason,
            session = %ctx.session_id,
            connection = %ctx.connection_id,
            user = %ctx.username,
            client_ip = %ctx.client_ip,
            duration_secs,
            "native session ending"
        ),
        None => tracing::info!(%reason, duration_secs, "native session ending"),
    }
    let _ = handle.terminate(reason).await;
    let _ = sink.close().await;
    // The recording's outcome is only known once the actor has finalised it.
    if tokio::time::timeout(ACTOR_TEARDOWN, handle.closed())
        .await
        .is_err()
    {
        tracing::warn!("session actor did not finish tearing down in time");
    }
    let fault = fault.and_then(|f| f.lock().ok().and_then(|g| g.clone()));

    if let Some(ctx) = nvr.as_ref() {
        if let Some(why) = &fault {
            recording_failed(Some(ctx), &handshake, user_id, "write", why).await;
        }
        finalize_session(ctx, bandwidth.as_ref(), fault.as_deref()).await;
    }
    Ok(())
}

/// Longest to wait for the actor's teardown, which bounds each of its
/// three steps at 10 seconds.
const ACTOR_TEARDOWN: Duration = Duration::from_secs(45);

/// First recording failure, shared between the actor's sink and the bridge.
type RecordingFault = Arc<std::sync::Mutex<Option<String>>>;

/// A `.guac` recording that reports its first failure and applies the
/// recording policy to it: a required recording ends the session, a
/// best-effort one stops recording and lets the session continue.
struct TrackedRecording {
    inner: GuacRecordingSink,
    required: bool,
    fault: RecordingFault,
    stopped: bool,
}

impl TrackedRecording {
    fn fail(
        &mut self,
        err: strata_session::SessionError,
    ) -> Result<(), strata_session::SessionError> {
        let why = err.to_string();
        if let Ok(mut fault) = self.fault.lock() {
            fault.get_or_insert_with(|| why.clone());
        }
        if self.required {
            return Err(err);
        }
        tracing::error!(error = %why, "recording failed; the session continues unrecorded");
        self.stopped = true;
        Ok(())
    }
}

#[async_trait::async_trait]
impl AuditSink for TrackedRecording {
    async fn record(&mut self, record: AuditRecord) -> Result<(), strata_session::SessionError> {
        if self.stopped {
            return Ok(());
        }
        match self.inner.record(record).await {
            Ok(()) => Ok(()),
            Err(e) => self.fail(e),
        }
    }

    async fn checkpoint(&mut self) -> Result<(), strata_session::SessionError> {
        if self.stopped {
            return Ok(());
        }
        match self.inner.checkpoint().await {
            Ok(()) => Ok(()),
            Err(e) => self.fail(e),
        }
    }

    async fn finalize(&mut self) -> Result<(), strata_session::SessionError> {
        if self.stopped {
            return Ok(());
        }
        let result = self.inner.finalize().await;
        if let Err(e) = &result {
            if let Ok(mut fault) = self.fault.lock() {
                fault.get_or_insert_with(|| e.to_string());
            }
        }
        result
    }
}

/// Set this session's recording status, if it has a recording.
async fn mark_recording(
    nvr: Option<&NvrContext>,
    handshake: &HandshakeParams,
    status: &str,
    why: &str,
) {
    if let (Some(ctx), Some(_)) = (nvr, &handshake.recording_name) {
        crate::services::recordings::mark_failed(&ctx.db_pool, &ctx.session_id, status, why).await;
    }
}

/// Mark the recording failed and raise `recording.failed`.
async fn recording_failed(
    nvr: Option<&NvrContext>,
    handshake: &HandshakeParams,
    user_id: Uuid,
    stage: &str,
    why: &str,
) {
    let Some(ctx) = nvr else {
        return;
    };
    if handshake.recording_name.is_none() {
        return;
    }
    // A write failure leaves what was recorded before it.
    let status = if stage == "write" {
        "incomplete"
    } else {
        "failed"
    };
    crate::services::recordings::mark_failed(&ctx.db_pool, &ctx.session_id, status, why).await;
    tracing::error!(session_id = %ctx.session_id, stage, error = why, "session recording failed");
    if let Err(e) = crate::services::audit::log(
        &ctx.db_pool,
        Some(user_id),
        "recording.failed",
        &serde_json::json!({
            "connection_id": ctx.connection_id.to_string(),
            "session_id": ctx.session_id,
            "stage": stage,
            "required": handshake.recording_required,
            "error": why,
        }),
    )
    .await
    {
        tracing::error!("could not audit the recording failure: {e}");
    }
}

/// Open the `.guac` recording for this session, if recording is on.
async fn open_recording(
    handshake: &HandshakeParams,
) -> Result<(Box<dyn AuditSink>, Option<RecordingFault>), AppError> {
    let (Some(dir), Some(name)) = (&handshake.recording_path, &handshake.recording_name) else {
        return Ok((Box::new(NullAuditSink), None));
    };
    let path = Path::new(dir).join(name);
    let sink = GuacRecordingSink::create(&path)
        .await
        .map_err(|e| AppError::Internal(format!("open recording {}: {e}", path.display())))?;
    tracing::info!(path = %path.display(), "recording native session");
    let fault = RecordingFault::default();
    Ok((
        Box::new(TrackedRecording {
            inner: sink,
            required: handshake.recording_required,
            fault: Arc::clone(&fault),
            stopped: false,
        }),
        Some(fault),
    ))
}

/// Why the watchdog wants the session closed.
struct WatchdogVerdict {
    client: &'static str,
    audit: &'static str,
}

fn watchdog_verdict(
    token: Option<&str>,
    started_at: tokio::time::Instant,
) -> Option<WatchdogVerdict> {
    if token.is_some_and(crate::services::token_revocation::is_revoked) {
        return Some(WatchdogVerdict {
            client: "This session was closed because your sign-in was revoked.",
            audit: "revoked",
        });
    }
    if started_at.elapsed() >= MAX_TUNNEL_DURATION {
        return Some(WatchdogVerdict {
            client: "This session reached the maximum allowed duration and was closed.",
            audit: "max_duration",
        });
    }
    None
}

/// Guacamole `SESSION_CONFLICT`: someone else ended the session.
const SESSION_CONFLICT: i32 = 0x0209;
/// Guacamole `SESSION_CLOSED`: the session ended by design.
const SESSION_CLOSED: i32 = 0x020B;
const SERVER_ERROR: i32 = 0x0200;
const UPSTREAM_UNAVAILABLE: i32 = 0x0208;
const CLIENT_UNAUTHORIZED: i32 = 0x0301;
const CLIENT_TOO_MANY: i32 = 0x031D;

/// Tell the client why it is being disconnected, best effort.
async fn send_error<S>(sink: &mut S, message: &str, status: i32)
where
    S: SinkExt<Message> + Unpin,
{
    let instruction = ServerInstruction::Error {
        text: message.to_owned(),
        status,
    }
    .to_bytes();
    let Ok(text) = String::from_utf8(instruction.to_vec()) else {
        return;
    };
    let _ = sink.send(Message::Text(text.into())).await;
}

/// End a session that never started, saying why.
async fn refuse(ws: &mut WebSocket, message: &str, status: i32) {
    send_error(ws, message, status).await;
    let _ = SinkExt::close(ws).await;
}

/// A session that could not reach its target, and why.
enum ConnectError {
    /// The protocol engine failed; the label names the protocol for the log.
    Engine(&'static str, EngineError),
    Other(AppError),
}

impl From<AppError> for ConnectError {
    fn from(e: AppError) -> Self {
        Self::Other(e)
    }
}

impl From<ConnectError> for AppError {
    fn from(e: ConnectError) -> Self {
        match e {
            ConnectError::Engine(protocol, e) => {
                AppError::Internal(format!("native {protocol} connect: {e}"))
            }
            ConnectError::Other(e) => e,
        }
    }
}

impl ConnectError {
    /// What the user is told, and the Guacamole status that titles it.
    fn notice(&self) -> (&'static str, i32) {
        match self {
            Self::Engine(_, EngineError::AuthRejected) => (
                "The remote computer rejected the username or password. Check the credentials before trying again: repeated attempts can lock the account.",
                CLIENT_UNAUTHORIZED,
            ),
            Self::Engine(_, EngineError::Transport(_) | EngineError::Closed(_)) => (
                "Could not connect to the remote computer. It may be switched off, unreachable from Strata, or not accepting connections.",
                UPSTREAM_UNAVAILABLE,
            ),
            Self::Engine(_, EngineError::Protocol(_) | EngineError::Unsupported(_)) => (
                "The remote computer answered in a way Strata could not use, so the session could not start.",
                SERVER_ERROR,
            ),
            Self::Other(_) => (
                "The session could not be started. Contact your administrator if this continues.",
                SERVER_ERROR,
            ),
        }
    }
}

/// Wake viewers, unregister, clean up shared files, and finalise the
/// recording row.
async fn finalize_session(
    ctx: &NvrContext,
    bandwidth: Option<&Arc<crate::services::session_registry::ActiveSession>>,
    recording_fault: Option<&str>,
) {
    let (bytes_down, bytes_up) = bandwidth.map_or((0i64, 0i64), |sess| {
        (
            sess.bytes_down.load(Ordering::Relaxed) as i64,
            sess.bytes_up.load(Ordering::Relaxed) as i64,
        )
    });

    // Viewers hold their own Arc, so they outlive `unregister` and would
    // otherwise sit on a silent socket forever.
    if let Some(sess) = bandwidth {
        sess.mark_ended();
    }
    ctx.registry.unregister(&ctx.session_id).await;

    let file_session_key = ctx.connection_id.to_string();
    let cleaned = ctx.file_store.cleanup_session(&file_session_key).await;
    if cleaned > 0 {
        tracing::info!("Cleaned up {cleaned} quick-share file(s) for session {file_session_key}");
    }

    let duration = (chrono::Utc::now() - ctx.started_at).num_seconds() as i32;
    // A status already set by a failure stands.
    let outcome = if recording_fault.is_some() {
        "incomplete"
    } else {
        "complete"
    };
    match sqlx::query(
        "UPDATE recordings SET duration_secs = $1, bytes_down = $2, bytes_up = $3, \
         engine = 'native', \
         status = CASE WHEN status = 'recording' THEN $5 ELSE status END \
         WHERE session_id = $4",
    )
    .bind(duration)
    .bind(bytes_down)
    .bind(bytes_up)
    .bind(&ctx.session_id)
    .bind(outcome)
    .execute(&ctx.db_pool)
    .await
    {
        Ok(r) if r.rows_affected() == 0 => tracing::warn!(
            session_id = %ctx.session_id,
            "recording finalize matched 0 rows — recording file may be orphaned"
        ),
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "failed to update recording duration"),
    }
}

/// Drain every complete instruction the decoder holds into the session.
///
/// Returns why the session must end, if it must. Malformed input is
/// terminal: a desynchronised Guacamole stream cannot be resynchronised,
/// and continuing would feed the target attacker-chosen fragments.
async fn forward_instructions(
    decoder: &mut GuacDecoder,
    handle: &SessionHandle,
) -> Result<(), &'static str> {
    loop {
        match decoder.next_instruction() {
            Ok(Some(instruction)) => handle
                .send(instruction)
                .await
                .map_err(|_| "session ended")?,
            Ok(None) => return Ok(()),
            Err(err) => {
                tracing::warn!(error = %err, "client sent malformed guacamole input");
                return Err("malformed client input");
            }
        }
    }
}

/// Forward a shared-control guest's frame. The actor confines it to input
/// and the guest's own clipboard; a malformed frame is dropped rather than
/// ending the operator's session.
async fn forward_guest_instructions(frame: &str, handle: &SessionHandle) -> Result<(), ()> {
    let mut decoder = GuacDecoder::default();
    decoder.extend(frame.as_bytes());
    loop {
        match decoder.next_instruction() {
            Ok(Some(instruction)) => handle.send_guest(instruction).await.map_err(drop)?,
            Ok(None) => return Ok(()),
            Err(err) => {
                tracing::warn!(error = %err, "dropped malformed input from a shared viewer");
                return Ok(());
            }
        }
    }
}

/// Connect to the target, and attach file transfer if it was asked for.
///
/// Also returns the SSH host key the target presented, for the caller to
/// pin (trust on first use) or audit (unverified).
async fn connect_engine(
    protocol: Protocol,
    handshake: &HandshakeParams,
) -> Result<(Box<dyn ProtocolEngine>, Option<DiscoveredHostKey>), ConnectError> {
    wake_target(handshake).await;

    let spec = TargetSpec {
        protocol,
        hostname: handshake.hostname.clone(),
        connect_addr: handshake.connect_addr,
        port: handshake.port,
        username: handshake.username.clone().unwrap_or_default(),
        secret: SecretString::from(handshake.password.clone().unwrap_or_default()),
        width: handshake.width,
        height: handshake.height,
    };

    let mut presented = None;
    let engine = connect_target(protocol, handshake, spec, &mut presented).await?;

    let Some(mut config) = sftp_config(handshake) else {
        return Ok((engine, presented));
    };
    // First use of a same-host transfer: hold it to the key the session saw.
    if matches!(config.host_keys, HostKeyPolicy::AcceptAny)
        && host_key_mode(handshake) == HostKeyMode::TrustOnFirstUse
    {
        if let Some(key) = &presented {
            config.host_keys = HostKeyPolicy::Fingerprints(vec![key.fingerprint.clone()]);
        }
    }
    // A failure here loses file transfer, not the session: the operator
    // is already connected to the target, and dropping them for a
    // secondary channel would be a worse trade than doing without it.
    match SftpEngine::attach(engine, Arc::new(config)).await {
        Ok(engine) => Ok((Box::new(engine), presented)),
        Err(err) => Err(AppError::Internal(format!("native sftp connect: {err}")).into()),
    }
}

/// Pin a trust-on-first-use host's key, or audit one accepted unverified.
async fn record_host_key(
    ctx: &NvrContext,
    handshake: &HandshakeParams,
    user_id: Uuid,
    key: &DiscoveredHostKey,
) {
    let details = |extra: serde_json::Value| {
        let mut base = serde_json::json!({
            "connection_id": ctx.connection_id.to_string(),
            "hostname": handshake.hostname,
            "algorithm": key.algorithm,
            "fingerprint": key.fingerprint,
        });
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        base
    };
    let action = match host_key_mode(handshake) {
        HostKeyMode::Pinned => return,
        HostKeyMode::TrustOnFirstUse => {
            if !host_key_fingerprints(handshake).is_empty() {
                return;
            }
            match pin_first_host_key(&ctx.db_pool, ctx.connection_id, &key.public_key).await {
                Ok(true) => "connection.host_key_pinned",
                // Another session pinned a key first; this one was admitted on its own.
                Ok(false) => return,
                Err(err) => {
                    tracing::warn!(error = %err, "could not pin a trust-on-first-use host key");
                    return;
                }
            }
        }
        HostKeyMode::Unverified => "connection.host_key_unverified",
    };
    let method = if action == "connection.host_key_pinned" {
        serde_json::json!({ "method": "trust_on_first_use" })
    } else {
        serde_json::json!({})
    };
    let _ =
        crate::services::audit::log(&ctx.db_pool, Some(user_id), action, &details(method)).await;
}

/// Store `public_key` as the connection's host key if it still has none.
/// Returns whether this call stored it.
async fn pin_first_host_key(
    pool: &sqlx::Pool<sqlx::Postgres>,
    connection_id: Uuid,
    public_key: &str,
) -> Result<bool, sqlx::Error> {
    let done = sqlx::query(
        "UPDATE connections
            SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{host-key}', to_jsonb($2::text))
          WHERE id = $1
            AND COALESCE(extra->>'host-key', '') = ''
            AND COALESCE(extra->>'host-key-fingerprint', '') = ''",
    )
    .bind(connection_id)
    .bind(public_key)
    .execute(pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Port used when the connection names no SFTP port of its own.
const DEFAULT_SSH_PORT: u16 = 22;

/// Settings for the file-transfer connection, when one was configured.
fn sftp_config(handshake: &HandshakeParams) -> Option<SftpConfig> {
    if !flag(handshake, "enable-sftp") {
        return None;
    }
    let get = |key: &str| {
        handshake
            .extra
            .get(key)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };

    let hostname = get("sftp-hostname").unwrap_or_else(|| handshake.hostname.clone());
    let port = get("sftp-port")
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_SSH_PORT);
    let username = get("sftp-username")
        .or_else(|| handshake.username.clone())
        .unwrap_or_default();

    let mut config = SftpConfig::new(hostname.clone(), port, username);
    // Only reuse the resolved address when SFTP goes to the same host as
    // the session; `sftp-hostname` names a different machine.
    if hostname == handshake.hostname {
        config.connect_addr = handshake.connect_addr;
    }
    config.password = get("sftp-password")
        .map(SecretString::from)
        .or_else(|| handshake.password.clone().map(SecretString::from));
    config.private_key = get("sftp-private-key").map(SecretString::from);
    config.passphrase = get("sftp-passphrase").map(SecretString::from);
    config.root = get("sftp-root-directory").unwrap_or_else(|| "/".to_owned());
    config.disable_download = flag(handshake, "sftp-disable-download");
    config.disable_upload = flag(handshake, "sftp-disable-upload");
    config.name = get("sftp-directory").unwrap_or_else(|| "Files".to_owned());
    config.host_keys = sftp_host_key_policy(handshake, &hostname);
    config.algorithms = ssh_algorithms(handshake);
    config.gate = handshake.transfer_gate.clone();
    Some(config)
}

/// The host key policy for the file-transfer connection.
///
/// An explicit `sftp-host-key` wins. Otherwise a transfer to the session's
/// own host follows the session's policy; a different host has nothing
/// pinned and is refused.
fn sftp_host_key_policy(handshake: &HandshakeParams, sftp_host: &str) -> HostKeyPolicy {
    let explicit = handshake
        .extra
        .get("sftp-host-key")
        .map(|raw| fingerprints_from(raw))
        .unwrap_or_default();
    if !explicit.is_empty() {
        return HostKeyPolicy::Fingerprints(explicit);
    }
    if sftp_host == handshake.hostname {
        return session_host_key_policy(handshake);
    }
    HostKeyPolicy::Fingerprints(Vec::new())
}

/// Open the server-side typescript a connection asked for.
///
/// Returns `None` when none was configured. A failure to create one is
/// fatal: it is an audit record an administrator deliberately turned on,
/// and running the session without it would be a silent downgrade.
async fn open_typescript(handshake: &HandshakeParams) -> Result<Option<Typescript>, AppError> {
    let Some(path) = handshake
        .extra
        .get("typescript-path")
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    else {
        return Ok(None);
    };
    let name = handshake
        .extra
        .get("typescript-name")
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .unwrap_or("typescript");

    Typescript::create(
        std::path::Path::new(path),
        name,
        flag(handshake, "create-typescript-path"),
    )
    .await
    .map(Some)
    .map_err(|e| AppError::Internal(format!("typescript {path}/{name}: {e}")))
}

async fn connect_target(
    protocol: Protocol,
    handshake: &HandshakeParams,
    spec: TargetSpec,
    presented: &mut Option<DiscoveredHostKey>,
) -> Result<Box<dyn ProtocolEngine>, ConnectError> {
    match protocol {
        Protocol::Ssh => {
            warn_ignored_params(handshake, SSH_PARAMS_IGNORED_NATIVELY, "ssh");

            // Loaded before the PTY is requested: the shell's rows and
            // columns are derived from the same cell geometry the
            // rasteriser draws with, so `nano`'s help bar lands on the
            // row the client actually sees.
            let font = TerminalFont::discover(terminal_font_size(handshake))
                .map_err(|e| AppError::Internal(format!("terminal font: {e}")))?;

            let config = SshConfig::with_policy(session_host_key_policy(handshake))
                .with_algorithms(ssh_algorithms(handshake))
                .with_cell_size(font.metrics().into())
                .with_private_key(
                    handshake
                        .extra
                        .get("private-key")
                        .filter(|k| !k.trim().is_empty())
                        .map(|k| SecretString::from(k.clone())),
                    handshake
                        .extra
                        .get("passphrase")
                        .filter(|p| !p.is_empty())
                        .map(|p| SecretString::from(p.clone())),
                )
                .with_terminal(
                    handshake.extra.get("terminal-type").cloned(),
                    handshake.extra.get("timezone").cloned(),
                )
                .with_backspace(backspace(handshake))
                .with_command(handshake.extra.get("command").cloned());
            let engine = SshEngine::connect(spec, Arc::new(config))
                .await
                .map_err(|e| ConnectError::Engine("ssh", e))?;
            *presented = engine.presented_host_key().cloned();

            let mut rasteriser = RasterisingEngine::with_appearance(
                Box::new(engine),
                font,
                handshake.width,
                handshake.height,
                &terminal_appearance(handshake),
            )
            .with_copy_disabled(flag(handshake, "disable-copy"));
            if let Some(typescript) = open_typescript(handshake).await? {
                rasteriser = rasteriser.with_typescript(typescript);
            }
            Ok(Box::new(rasteriser))
        }
        Protocol::Rdp => {
            warn_unsupported_rdp_params(handshake);
            let (keyboard_layout, unicode_keyboard) = rdp_keyboard(handshake);
            let desktop_scale_factor = desktop_scale_factor_from_dpi(handshake.dpi);
            let factory = RdpEngineFactory::new(RdpConfig {
                domain: handshake.domain.clone(),
                kdc_url: kdc_url(handshake),
                keyboard_layout,
                unicode_keyboard,
                client_name: handshake
                    .extra
                    .get("client-name")
                    .map(|n| n.trim())
                    .filter(|n| !n.is_empty())
                    .map_or_else(|| RdpConfig::default().client_name, str::to_owned),
                read_only: flag(handshake, "read-only"),
                disable_copy: flag(handshake, "disable-copy"),
                disable_paste: flag(handshake, "disable-paste"),
                // Audio is on unless the connection turns it off, which is
                // how guacd read the same parameter.
                enable_audio: !flag(handshake, "disable-audio"),
                cert_policy: rdp_cert_policy(handshake).map_err(AppError::Validation)?,
                color_depth: color_depth(handshake),
                performance: RdpPerformance {
                    wallpaper: flag(handshake, "enable-wallpaper"),
                    theming: flag(handshake, "enable-theming"),
                    // Matches the guacd default, so the two engines render
                    // glyphs the same way.
                    font_smoothing: flag_or(handshake, "enable-font-smoothing", true),
                    full_window_drag: flag(handshake, "enable-full-window-drag"),
                    desktop_composition: flag(handshake, "enable-desktop-composition"),
                    menu_animations: flag(handshake, "enable-menu-animations"),
                },
                load_balance_info: handshake
                    .extra
                    .get("load-balance-info")
                    .map(|t| t.trim())
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned),
                desktop_scale_factor,
                enable_webp: flag_or(handshake, "enable-webp", true),
                enable_h264: flag_or(handshake, "enable-h264", true),
                // `disable-gfx` is a negative with three states: the editor
                // writes "false" to mean GFX on, "true" to mean off, and
                // leaves it unset when the administrator never touched it.
                // Only an explicit "false" turns the pipeline on.
                enable_gfx: handshake
                    .extra
                    .get("disable-gfx")
                    .is_some_and(|v| v.trim() == "false"),
            });
            factory
                .connect(spec)
                .await
                .map_err(|e| ConnectError::Engine("rdp", e))
        }
        Protocol::Vnc => {
            warn_ignored_params(handshake, VNC_PARAMS_IGNORED_NATIVELY, "vnc");
            let factory = VncEngineFactory::new(VncConfig {
                read_only: flag(handshake, "read-only"),
                disable_copy: flag(handshake, "disable-copy"),
                disable_paste: flag(handshake, "disable-paste"),
                dest_host: handshake
                    .extra
                    .get("dest-host")
                    .map(|h| h.trim())
                    .filter(|h| !h.is_empty())
                    .map(str::to_owned),
                dest_port: handshake
                    .extra
                    .get("dest-port")
                    .and_then(|p| p.trim().parse().ok()),
                reverse_connect: flag(handshake, "reverse-connect"),
                listen_timeout: handshake
                    .extra
                    .get("listen-timeout")
                    .and_then(|t| t.trim().parse().ok())
                    .map_or(DEFAULT_LISTEN_TIMEOUT, Duration::from_secs),
                clipboard_encoding: clipboard_encoding(handshake),
            });
            factory
                .connect(spec)
                .await
                .map_err(|e| ConnectError::Engine("vnc", e))
        }
        Protocol::KubeExec => {
            warn_ignored_params(handshake, KUBE_PARAMS_IGNORED_NATIVELY, "kubernetes");

            // Loaded before the exec stream is opened, for the same
            // reason as SSH above: the remote grid has to match the one
            // the rasteriser draws.
            let font = TerminalFont::discover(terminal_font_size(handshake))
                .map_err(|e| AppError::Internal(format!("terminal font: {e}")))?;

            let factory = KubeEngineFactory::new(KubeConfig {
                backspace: backspace(handshake),
                namespace: handshake
                    .extra
                    .get("namespace")
                    .map(|n| n.trim())
                    .filter(|n| !n.is_empty())
                    .map_or_else(|| "default".to_owned(), str::to_owned),
                pod: handshake.extra.get("pod").cloned().unwrap_or_default(),
                container: handshake.extra.get("container").cloned(),
                command: exec_command(handshake),
                // guacd treats the parameter as on unless explicitly "false".
                use_ssl: handshake
                    .extra
                    .get("use-ssl")
                    .is_none_or(|v| v.trim() != "false"),
                verify_certificate: !handshake.ignore_cert && !flag(handshake, "ignore-cert"),
                ca_cert: handshake.extra.get("ca-cert").cloned(),
                client_cert: handshake.extra.get("client-cert").cloned(),
                client_key: handshake
                    .extra
                    .get("client-key")
                    .filter(|k| !k.trim().is_empty())
                    .map(|k| SecretString::from(k.clone())),
                client_key_password: handshake
                    .extra
                    .get("client-key-password")
                    .filter(|p| !p.is_empty())
                    .map(|p| SecretString::from(p.clone())),
                cell: font.metrics().into(),
                read_only: flag(handshake, "read-only"),
                disable_copy: flag(handshake, "disable-copy"),
                disable_paste: flag(handshake, "disable-paste"),
            });
            let engine = factory
                .connect(spec)
                .await
                .map_err(|e| ConnectError::Engine("kubernetes", e))?;

            let mut rasteriser = RasterisingEngine::with_appearance(
                engine,
                font,
                handshake.width,
                handshake.height,
                &terminal_appearance(handshake),
            )
            .with_copy_disabled(flag(handshake, "disable-copy"));
            if let Some(typescript) = open_typescript(handshake).await? {
                rasteriser = rasteriser.with_typescript(typescript);
            }
            Ok(Box::new(rasteriser))
        }
    }
}

/// Wake the target first if the connection asks for it.
///
/// Failure is logged but never fatal: the target is usually already
/// awake, and refusing to connect because a magic packet did not send
/// would break a working connection to fix one that was not.
async fn wake_target(handshake: &HandshakeParams) {
    if !flag(handshake, "wol-send-packet") {
        return;
    }
    let Some(mac) = handshake.extra.get("wol-mac-addr").map(|m| m.trim()) else {
        tracing::warn!("connection asks to send a wake packet but names no MAC address");
        return;
    };
    let broadcast = handshake
        .extra
        .get("wol-broadcast-addr")
        .map(|b| b.trim())
        .filter(|b| !b.is_empty())
        .unwrap_or(wol::DEFAULT_BROADCAST);
    let port = handshake
        .extra
        .get("wol-udp-port")
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(wol::DEFAULT_PORT);
    let settle = Duration::from_secs(
        handshake
            .extra
            .get("wol-wait-time")
            .and_then(|w| w.trim().parse().ok())
            .unwrap_or(0),
    );

    if let Err(err) = wol::wake(mac, broadcast, port, settle).await {
        tracing::warn!(error = %err, "could not wake the target; connecting anyway");
    }
}

/// The command to exec, split the way a shell would split it.///
/// guacd defaults to a plain shell when the parameter is absent, and a
/// session that drops the operator somewhere other than where guacd
/// would is a surprise worth avoiding.
fn exec_command(handshake: &HandshakeParams) -> Vec<String> {
    handshake
        .extra
        .get("exec-command")
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .map_or_else(
            || vec!["/bin/sh".to_owned()],
            |c| c.split_whitespace().map(str::to_owned).collect(),
        )
}

/// Derive an RDP desktop scale factor percentage (100..=500) from a display DPI.
///
/// Delegates to the engine so the connect-time scale and the one the
/// engine recomputes on resize can never disagree.
fn desktop_scale_factor_from_dpi(dpi: u32) -> Option<u32> {
    strata_session::engine::rdp::desktop_scale_from_dpi(dpi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rejected_password_is_named_and_keeps_its_log_text() {
        let e = ConnectError::Engine("rdp", EngineError::AuthRejected);
        let (notice, status) = e.notice();
        assert!(
            notice.contains("rejected the username or password"),
            "{notice}"
        );
        assert_eq!(status, CLIENT_UNAUTHORIZED);
        assert_eq!(
            AppError::from(e).to_string(),
            "native rdp connect: authentication rejected by target"
        );
    }

    #[test]
    fn an_unreachable_target_is_not_blamed_on_the_credentials() {
        let refused = std::io::Error::from(std::io::ErrorKind::ConnectionRefused);
        let (notice, status) =
            ConnectError::Engine("ssh", EngineError::Transport(refused)).notice();
        assert!(!notice.contains("password"), "{notice}");
        assert_eq!(status, UPSTREAM_UNAVAILABLE);
    }

    #[test]
    fn other_start_up_failures_stay_generic() {
        let e = ConnectError::from(AppError::Internal("terminal font: missing".into()));
        assert_eq!(e.notice().1, SERVER_ERROR);
        assert_eq!(AppError::from(e).to_string(), "terminal font: missing");
    }

    fn handshake(protocol: &str, fingerprint: Option<&str>) -> HandshakeParams {
        let mut extra = std::collections::HashMap::new();
        if let Some(fp) = fingerprint {
            extra.insert(HOST_KEY_PARAM.to_owned(), fp.to_owned());
        }
        HandshakeParams {
            connect_addr: None,
            protocol: protocol.to_owned(),
            hostname: "host.internal".to_owned(),
            port: 22,
            username: Some("svc".to_owned()),
            password: Some("secret".to_owned()),
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            recording_required: false,
            width: 1024,
            height: 768,
            dpi: 96,
            extra,
            transfer_gate: None,
        }
    }

    /// SHA-256 of the empty input: a real digest, so it parses, without
    /// needing a certificate fixture.
    const A_FINGERPRINT: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn the_backspace_key_follows_the_connection() {
        let mut hs = handshake("ssh", None);
        assert_eq!(backspace(&hs), Backspace::Delete);

        hs.extra.insert("backspace".into(), "8".into());
        assert_eq!(backspace(&hs), Backspace::Backspace);

        hs.extra.insert("backspace".into(), "127".into());
        assert_eq!(backspace(&hs), Backspace::Delete);

        // Anything else keeps DEL: the wrong code here breaks line
        // editing on every session, so a typo must not pick for us.
        for junk in ["", "  ", "del", "0"] {
            hs.extra.insert("backspace".into(), junk.into());
            assert_eq!(backspace(&hs), Backspace::Delete, "{junk:?}");
        }
    }

    #[test]
    fn the_keyboard_layout_defaults_to_uk_english() {
        let mut hs = handshake("rdp", None);
        assert_eq!(rdp_keyboard(&hs), (0x0809, false));

        hs.extra.insert("server-layout".into(), "  ".into());
        assert_eq!(rdp_keyboard(&hs), (0x0809, false));

        hs.extra
            .insert("server-layout".into(), "en-us-qwerty".into());
        assert_eq!(rdp_keyboard(&hs), (0x0409, false));

        hs.extra
            .insert("server-layout".into(), "de-de-qwertz".into());
        assert_eq!(rdp_keyboard(&hs), (0x0407, false));

        // Typing on a guessed layout moves symbols; Unicode does not.
        for unicode in ["failsafe", "cs-cz-qwertz"] {
            hs.extra.insert("server-layout".into(), unicode.into());
            assert_eq!(rdp_keyboard(&hs), (0x0809, true), "{unicode}");
        }
    }

    /// Every layout the admin panel offers must type through a bundled
    /// keymap. One that silently fell back to Unicode would break typing
    /// in PSReadLine on Server Core, the bug fixed in 2.3.1.
    #[test]
    fn every_layout_the_admin_panel_offers_has_a_keymap() {
        use strata_session::engine::rdp::layouts::keymap_for_layout;

        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../frontend/src/pages/admin/rdpKeyboardLayouts.ts"
        ))
        .expect("frontend layout list");
        let offered: Vec<&str> = source
            .split("value: \"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert!(offered.contains(&"") && offered.contains(&"failsafe"));
        assert!(offered.len() > 10, "parsed {offered:?}");

        let mut hs = handshake("rdp", None);
        for name in offered {
            if name.is_empty() || name == "failsafe" {
                continue;
            }
            let id = keyboard_layout_id(name).unwrap_or_else(|| panic!("{name} has no layout id"));
            assert!(keymap_for_layout(id).is_some(), "{name} has no keymap");
            hs.extra.insert("server-layout".into(), name.into());
            assert_eq!(rdp_keyboard(&hs), (id, false), "{name}");
        }
    }

    #[test]
    fn only_the_colour_depths_guacd_offers_are_accepted() {
        let mut hs = handshake("rdp", None);
        assert_eq!(color_depth(&hs), None);

        for depth in [8u32, 16, 24, 32] {
            hs.extra.insert("color-depth".into(), depth.to_string());
            assert_eq!(color_depth(&hs), Some(depth));
        }
        // A depth the server would reject costs the session, so an
        // unknown value keeps the default rather than being forwarded.
        for junk in ["1", "31", "64", "true", ""] {
            hs.extra.insert("color-depth".into(), junk.into());
            assert_eq!(color_depth(&hs), None, "{junk:?}");
        }
    }

    #[test]
    fn the_ignored_lists_hold_only_what_is_genuinely_unimplemented() {
        // Honoured now.
        for honoured in ["backspace", "font-size", "color-scheme", "scrollback"] {
            assert!(
                !SSH_PARAMS_IGNORED_NATIVELY.contains(&honoured),
                "{honoured}"
            );
            assert!(
                !KUBE_PARAMS_IGNORED_NATIVELY.contains(&honoured),
                "{honoured}"
            );
        }
        assert!(!RDP_PARAMS_IGNORED_NATIVELY.contains(&"color-depth"));
        // Already satisfied: the encoder only ever emits PNG.
        assert!(!RDP_PARAMS_IGNORED_NATIVELY.contains(&"force-lossless"));
        // Removed from the editor in migration 088 rather than left
        // acting on nothing once guacd goes.
        for dropped in ["enable-h264", "resize-method"] {
            assert!(!RDP_PARAMS_IGNORED_NATIVELY.contains(&dropped), "{dropped}");
        }
    }

    #[test]
    fn the_terminal_follows_the_connections_colour_scheme_and_scrollback() {
        let mut hs = handshake("ssh", None);
        let default = terminal_appearance(&hs);
        assert_eq!(default.palette, Palette::default());

        hs.extra.insert("color-scheme".into(), "green-black".into());
        hs.extra.insert("scrollback".into(), "250".into());
        let tuned = terminal_appearance(&hs);
        assert_eq!(tuned.palette, Palette::from_scheme("green-black").unwrap());
        assert_eq!(tuned.scrollback, 250);
    }

    #[test]
    fn an_unknown_colour_scheme_keeps_the_default_rather_than_guessing() {
        let mut hs = handshake("ssh", None);
        hs.extra.insert("color-scheme".into(), "mauve".into());
        assert_eq!(terminal_appearance(&hs).palette, Palette::default());
    }

    #[test]
    fn scrollback_is_capped_because_the_server_holds_it() {
        // The history lives in the session actor, so an unbounded value
        // here is memory the server pays for, not the client.
        let mut hs = handshake("ssh", None);
        hs.extra.insert("scrollback".into(), "100000000".into());
        assert_eq!(terminal_appearance(&hs).scrollback, MAX_SCROLLBACK_LINES);

        // Junk keeps the default rather than zeroing the history.
        hs.extra.insert("scrollback".into(), "lots".into());
        assert_eq!(
            terminal_appearance(&hs).scrollback,
            TerminalAppearance::default().scrollback
        );
    }

    #[test]
    fn the_terminal_font_follows_the_connections_font_size() {
        // guacd takes points at 96 DPI; the rasteriser takes pixels, so
        // the same 4/3 ratio a browser uses.
        let mut hs = handshake("ssh", None);
        assert_eq!(terminal_font_size(&hs), DEFAULT_FONT_SIZE_PX);

        hs.extra.insert("font-size".into(), "12".into());
        assert_eq!(terminal_font_size(&hs), 16.0);

        hs.extra.insert("font-size".into(), " 9 ".into());
        assert_eq!(terminal_font_size(&hs), 12.0);
    }

    #[test]
    fn an_unusable_font_size_is_clamped_rather_than_failing_the_session() {
        // A terminal nobody can read is not an improvement on one that
        // ignored the setting, and neither is refusing to connect.
        let mut hs = handshake("ssh", None);
        for (value, expect) in [("1", 8.0), ("9999", 72.0)] {
            hs.extra.insert("font-size".into(), value.into());
            assert_eq!(terminal_font_size(&hs), expect, "font-size {value}");
        }
        for junk in ["", "  ", "big", "-4", "0", "NaN"] {
            hs.extra.insert("font-size".into(), junk.into());
            assert_eq!(
                terminal_font_size(&hs),
                DEFAULT_FONT_SIZE_PX,
                "font-size {junk:?} should fall back to the default"
            );
        }
    }

    #[test]
    fn font_size_is_no_longer_reported_as_ignored() {
        // It is honoured now, so warning about it would send an
        // administrator looking for a problem that does not exist.
        assert!(!SSH_PARAMS_IGNORED_NATIVELY.contains(&"font-size"));
        assert!(!KUBE_PARAMS_IGNORED_NATIVELY.contains(&"font-size"));
        // Honoured now, so warning about them would send an
        // administrator looking for a problem that does not exist.
        for honoured in ["color-scheme", "scrollback"] {
            assert!(
                !SSH_PARAMS_IGNORED_NATIVELY.contains(&honoured),
                "{honoured}"
            );
            assert!(
                !KUBE_PARAMS_IGNORED_NATIVELY.contains(&honoured),
                "{honoured}"
            );
        }
        // Display Control is always attached, so display-update is what
        // the engine already does.
        assert!(!RDP_PARAMS_IGNORED_NATIVELY.contains(&"resize-method"));
        // Removed outright rather than left as a toggle acting on
        // nothing: the native engine has no GFX pipeline.
        assert!(!RDP_PARAMS_IGNORED_NATIVELY.contains(&"enable-h264"));
    }

    #[test]
    fn a_blank_protocol_list_means_every_compiled_protocol() {
        // Compose passes the variable through as `${VAR:-}`, so
        // commenting the line out in `.env` still arrives as "". Reading
        // that literally left nothing eligible, which under native-only
        // refuses every session instead of serving them all.
        let available = RoutingPolicy::compiled_protocols();
        assert!(!available.is_empty());
        for blank in [None, Some(""), Some("   "), Some(" , ")] {
            assert_eq!(
                eligible_protocols(blank, &available),
                available,
                "blank value {blank:?} should mean every compiled protocol"
            );
        }
    }

    #[test]
    fn kubernetes_is_eligible_when_the_list_is_left_unset() {
        // The gap this closed: `rdp,ssh,vnc` omitted kubernetes, and
        // under native-only an omitted protocol is refused rather than
        // quietly handed to guacd.
        let available = RoutingPolicy::compiled_protocols();
        assert!(eligible_protocols(None, &available).contains(&Protocol::KubeExec));
        assert!(!eligible_protocols(Some("rdp,ssh,vnc"), &available).contains(&Protocol::KubeExec));
    }

    #[test]
    fn an_explicit_list_is_honoured_and_typos_do_not_widen_it() {
        let available = RoutingPolicy::compiled_protocols();
        let eligible = eligible_protocols(Some("rdp, nonsense ,ssh"), &available);
        assert_eq!(
            eligible,
            HashSet::from([Protocol::Rdp, Protocol::Ssh]),
            "an unknown entry must not fall back to allowing everything"
        );

        // Naming nothing and naming only nonsense are different: the
        // first expressed no restriction, the second expressed one we
        // could not honour, and quietly widening that would enable the
        // engine for protocols nobody asked for.
        assert!(eligible_protocols(Some("nonsense"), &available).is_empty());
    }

    fn rdp_handshake(params: &[(&str, &str)]) -> HandshakeParams {
        let mut hs = handshake("rdp", None);
        hs.extra.clear();
        for (k, v) in params {
            hs.extra.insert((*k).to_owned(), (*v).to_owned());
        }
        hs
    }

    #[test]
    fn a_connection_with_no_certificate_settings_behaves_as_it_always_did() {
        let mut hs = rdp_handshake(&[]);
        assert!(matches!(
            rdp_cert_policy(&hs),
            Ok(CertPolicy::Verify { extra_roots: None })
        ));
        hs.ignore_cert = true;
        assert!(matches!(rdp_cert_policy(&hs), Ok(CertPolicy::Ignore)));
    }

    #[test]
    fn an_attached_ca_and_a_pin_both_outrank_the_ignore_box() {
        // An administrator who set either made a specific statement
        // about this target; honouring "ignore certificate" over it
        // would make the field a no-op, which is the class of bug the
        // fields were added to fix.
        let mut hs = rdp_handshake(&[(TRUSTED_CA_PEM_PARAM, "-----BEGIN CERTIFICATE-----")]);
        hs.ignore_cert = true;
        assert!(matches!(
            rdp_cert_policy(&hs),
            Ok(CertPolicy::Verify {
                extra_roots: Some(_)
            })
        ));

        let mut hs = rdp_handshake(&[(CERT_FINGERPRINTS_PARAM, A_FINGERPRINT)]);
        hs.ignore_cert = true;
        assert!(matches!(
            rdp_cert_policy(&hs),
            Ok(CertPolicy::Pinned { .. })
        ));
    }

    #[test]
    fn a_pin_outranks_an_attached_ca() {
        // Pinning names one certificate; a CA vouches for a whole
        // namespace. The narrower statement wins.
        let hs = rdp_handshake(&[
            (CERT_FINGERPRINTS_PARAM, A_FINGERPRINT),
            (TRUSTED_CA_PEM_PARAM, "-----BEGIN CERTIFICATE-----"),
        ]);
        assert!(matches!(
            rdp_cert_policy(&hs),
            Ok(CertPolicy::Pinned { .. })
        ));
    }

    #[test]
    fn several_pins_may_be_listed_on_one_connection() {
        // A host re-issued mid-rollout presents either certificate, so
        // pinning only one would fail intermittently.
        let hs = rdp_handshake(&[(
            CERT_FINGERPRINTS_PARAM,
            &format!("{A_FINGERPRINT},\n SHA256:{A_FINGERPRINT}"),
        )]);
        let Ok(CertPolicy::Pinned { fingerprints }) = rdp_cert_policy(&hs) else {
            panic!("expected pinning");
        };
        assert_eq!(fingerprints.len(), 2);
        assert_eq!(fingerprints[0], fingerprints[1]);
    }

    #[test]
    fn a_mistyped_fingerprint_fails_the_connection_rather_than_narrowing_it() {
        // Skipping the bad entry would leave the good ones looking like
        // the whole list, so a typo would quietly change what the
        // connection accepts instead of being corrected.
        let hs = rdp_handshake(&[(CERT_FINGERPRINTS_PARAM, &format!("{A_FINGERPRINT}, wat"))]);
        let err = rdp_cert_policy(&hs).expect_err("mistyped fingerprint");
        assert!(err.contains("wat"), "{err}");

        // And it is caught by preflight, before the target is dialled.
        let err = preflight(Protocol::Rdp, &hs).expect_err("mistyped fingerprint");
        assert!(err.contains("wat"), "{err}");
    }

    #[test]
    fn an_empty_fingerprint_list_is_not_treated_as_pinning() {
        // Otherwise clearing the box would build a verifier that
        // matches nothing and refuse every certificate.
        let hs = rdp_handshake(&[(CERT_FINGERPRINTS_PARAM, "  ,\n  ")]);
        assert!(matches!(
            rdp_cert_policy(&hs),
            Ok(CertPolicy::Verify { extra_roots: None })
        ));
    }

    #[test]
    fn a_discovered_kdc_is_normalised_for_both_engines() {
        // guacd passes this straight to FreeRDP without normalising, so
        // a bare hostname discovered from the realm table must not reach
        // the handshake unqualified.
        assert_eq!(
            normalise_kdc("cicsazvm001.example.co.uk"),
            Some("tcp://cicsazvm001.example.co.uk:88".to_owned())
        );
        // An address that already names a scheme is the admin's choice.
        assert_eq!(
            normalise_kdc(" tcp://kdc.example:88 "),
            Some("tcp://kdc.example:88".to_owned())
        );
        assert_eq!(normalise_kdc("   "), None);
    }

    #[test]
    fn the_installed_shutdown_token_is_visible_to_the_session_loop() {
        // Sets process-wide state, so it is deliberately the only test
        // that touches the shutdown token.
        let token = tokio_util::sync::CancellationToken::new();
        set_shutdown_token(token.clone());
        assert!(!shutdown_token().is_cancelled());
        token.cancel();
        assert!(
            shutdown_token().is_cancelled(),
            "a shutting-down gateway would still report the target hung up"
        );
    }

    #[test]
    fn protocol_names_map_to_engine_protocols() {
        assert_eq!(protocol_from_str("ssh"), Some(Protocol::Ssh));
        assert_eq!(protocol_from_str("RDP"), Some(Protocol::Rdp));
        assert_eq!(protocol_from_str(" vnc "), Some(Protocol::Vnc));
        assert_eq!(protocol_from_str("kubernetes"), Some(Protocol::KubeExec));
        assert_eq!(protocol_from_str("telnet"), None);
    }

    #[test]
    fn a_session_without_a_pinned_host_key_is_not_run_natively() {
        let err = preflight(Protocol::Ssh, &handshake("ssh", None)).unwrap_err();
        assert!(err.contains(HOST_KEY_PARAM));
    }

    #[test]
    fn fingerprints_are_split_and_trimmed() {
        let params = handshake("ssh", Some(" SHA256:aaa , SHA256:bbb ,"));
        assert_eq!(
            host_key_fingerprints(&params),
            vec!["SHA256:aaa".to_owned(), "SHA256:bbb".to_owned()]
        );
    }

    #[test]
    fn a_guacd_host_key_verifies_the_same_host_natively() {
        // Expected value from `ssh-keygen -lf`, not from this code: a
        // fingerprint computed a different way would silently pin a
        // different host, and a self-derived expectation would not catch it.
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJk8AhaZaCLPfHOnEqmB6h8gW1jCbCJKzJBAbUX3jIEy admin@example";
        assert_eq!(
            fingerprint_openssh_key(key).as_deref(),
            Some("SHA256:P1lX1ochzqvz3Bx6Hxyabr/NQJfpUMJkcjXQC0mgywA")
        );
    }

    #[test]
    fn an_ssh_connection_configured_for_guacd_needs_no_re_entry() {
        // The admin panel offers only guacd's OpenSSH-format field, so
        // requiring a SHA256 fingerprint would leave native SSH
        // unreachable through the product.
        let mut params = handshake("ssh", None);
        params.extra.insert(
            "host-key".to_owned(),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJk8AhaZaCLPfHOnEqmB6h8gW1jCbCJKzJBAbUX3jIEy"
                .to_owned(),
        );
        assert_eq!(host_key_fingerprints(&params).len(), 1);
    }

    #[test]
    fn every_host_key_offered_is_pinned() {
        // A host serves more than one key type and negotiation picks one,
        // so keeping only the first would fail whenever the other was
        // chosen. Both fingerprints are from ssh-keygen -lf.
        let mut params = handshake("ssh", None);
        params.extra.insert(
            "host-key".to_owned(),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRyUXxWUTcu0GBVIFZkukPePhBZFsyyf2f1Jv55toh7\n\
             ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJk8AhaZaCLPfHOnEqmB6h8gW1jCbCJKzJBAbUX3jIEy"
                .to_owned(),
        );
        assert_eq!(
            host_key_fingerprints(&params),
            vec![
                "SHA256:gS7tXum41YCAi1KzCofSD8Ls5CkbS6bYtJJdc23K/XI".to_owned(),
                "SHA256:P1lX1ochzqvz3Bx6Hxyabr/NQJfpUMJkcjXQC0mgywA".to_owned(),
            ]
        );
    }

    #[test]
    fn an_explicit_fingerprint_wins_over_the_derived_one() {
        let mut params = handshake("ssh", Some("SHA256:pinned"));
        params
            .extra
            .insert("host-key".to_owned(), "ssh-ed25519 AAAAC3NzaC1l".to_owned());
        assert_eq!(host_key_fingerprints(&params), vec!["SHA256:pinned"]);
    }

    #[test]
    fn a_host_key_that_does_not_parse_leaves_the_session_on_guacd() {
        // Guessing a fingerprint here would pin a host nobody verified.
        for junk in ["", "not-a-key", "ssh-rsa !!!!", "ssh-rsa AAA"] {
            let mut params = handshake("ssh", None);
            params.extra.insert("host-key".to_owned(), junk.to_owned());
            assert!(
                host_key_fingerprints(&params).is_empty(),
                "{junk:?} must not produce a fingerprint"
            );
            assert!(preflight(Protocol::Ssh, &params).is_err());
        }
    }

    #[test]
    fn a_connection_with_no_pod_fails_preflight() {
        let err = preflight(Protocol::KubeExec, &handshake("kubernetes", None)).unwrap_err();
        assert!(err.contains("pod"), "{err}");
    }

    fn kube_handshake() -> HandshakeParams {
        let mut params = handshake("kubernetes", None);
        params.extra.insert("pod".to_owned(), "web-0".to_owned());
        params
    }

    /// Nothing about a Kubernetes exec session needs guacd now, which
    /// includes the encrypted client key that used to.
    #[test]
    fn no_kubernetes_parameter_forces_guacd() {
        let mut params = kube_handshake();
        params
            .extra
            .insert("client-key-password".to_owned(), "hunter2".to_owned());
        assert!(preflight(Protocol::KubeExec, &params).is_ok());
    }

    #[test]
    fn ignored_kubernetes_params_still_run_natively() {
        for param in KUBE_PARAMS_IGNORED_NATIVELY {
            let mut params = kube_handshake();
            params.extra.insert((*param).to_owned(), "true".to_owned());
            assert!(
                preflight(Protocol::KubeExec, &params).is_ok(),
                "{param} should not force guacd"
            );
        }
    }

    /// guacd drops the operator in a shell when the parameter is absent;
    /// landing somewhere else would be a surprise.
    #[test]
    fn an_unset_exec_command_is_a_shell() {
        assert_eq!(exec_command(&kube_handshake()), vec!["/bin/sh".to_owned()]);
    }

    #[test]
    fn an_exec_command_is_split_into_arguments() {
        let mut params = kube_handshake();
        params
            .extra
            .insert("exec-command".to_owned(), "  /bin/bash -l  ".to_owned());
        assert_eq!(
            exec_command(&params),
            vec!["/bin/bash".to_owned(), "-l".to_owned()]
        );
    }

    #[test]
    fn vnc_needs_no_pinned_host_key_or_font() {
        let mut params = handshake("vnc", None);
        params.username = None;
        assert!(preflight(Protocol::Vnc, &params).is_ok());
    }

    /// Neither RFB security type carries a username, so honouring one
    /// would mean silently not honouring it.
    #[test]
    fn vnc_with_a_username_stays_on_guacd() {
        let params = handshake("vnc", None);
        let err = preflight(Protocol::Vnc, &params).unwrap_err();
        assert!(err.contains("username"), "{err}");
    }

    /// Fidelity-only parameters must not cost a session the native
    /// engine, or the gate list grows until nothing routes natively.
    #[test]
    fn ignored_vnc_params_still_run_natively() {
        for param in VNC_PARAMS_IGNORED_NATIVELY {
            let mut params = handshake("vnc", None);
            params.username = None;
            params.extra.insert((*param).to_owned(), "true".to_owned());
            assert!(
                preflight(Protocol::Vnc, &params).is_ok(),
                "{param} should not force guacd"
            );
        }
    }

    /// An encoding the engine cannot produce falls back to the RFB
    /// default rather than refusing the session, which is what guacd
    /// does with a value it does not recognise.
    #[test]
    fn every_clipboard_encoding_runs_natively() {
        for encoding in [
            "ISO8859-1",
            "UTF-8",
            "UTF-16",
            "CP1252",
            "MacRoman",
            "KOI8-R",
        ] {
            let mut params = handshake("vnc", None);
            params.username = None;
            params
                .extra
                .insert("clipboard-encoding".to_owned(), encoding.to_owned());
            assert!(
                preflight(Protocol::Vnc, &params).is_ok(),
                "{encoding} should not force guacd"
            );
        }
    }

    #[test]
    fn only_utf8_is_carried_as_utf8() {
        let mut params = handshake("vnc", None);
        params
            .extra
            .insert("clipboard-encoding".to_owned(), "UTF-8".to_owned());
        assert_eq!(clipboard_encoding(&params), ClipboardEncoding::Utf8);

        for encoding in ["ISO8859-1", "UTF-16", "CP1252", "MacRoman", "KOI8-R"] {
            let mut params = handshake("vnc", None);
            params
                .extra
                .insert("clipboard-encoding".to_owned(), encoding.to_owned());
            assert_eq!(
                clipboard_encoding(&params),
                ClipboardEncoding::Latin1,
                "{encoding} should fall back to the RFB default"
            );
        }
    }

    #[test]
    fn an_unrecognised_clipboard_encoding_falls_back_to_the_rfb_default() {
        let mut params = handshake("vnc", None);
        params
            .extra
            .insert("clipboard-encoding".to_owned(), "KOI8-R".to_owned());
        assert_eq!(clipboard_encoding(&params), ClipboardEncoding::Latin1);
    }

    #[test]
    fn rdp_needs_no_pinned_host_key_or_font() {
        assert!(preflight(Protocol::Rdp, &handshake("rdp", None)).is_ok());
    }

    /// File transfer dials its own SSH connection, so it needs a pinned
    /// key just as the session does.
    #[test]
    fn file_transfer_without_a_pinned_host_key_is_refused() {
        let mut params = handshake("rdp", None);
        params
            .extra
            .insert("enable-sftp".to_owned(), "true".to_owned());
        params
            .extra
            .insert("sftp-hostname".to_owned(), "files.internal".to_owned());
        let err = preflight(Protocol::Rdp, &params).unwrap_err();
        assert!(err.contains("sftp-host-key"), "{err}");
    }

    #[test]
    fn file_transfer_with_a_pinned_host_key_runs_natively() {
        let mut params = handshake("rdp", None);
        params
            .extra
            .insert("enable-sftp".to_owned(), "true".to_owned());
        params
            .extra
            .insert("sftp-host-key".to_owned(), "SHA256:aaa".to_owned());
        assert!(preflight(Protocol::Rdp, &params).is_ok());
    }

    /// The session's own key covers file transfer only when both go to
    /// the same host; reusing it elsewhere would pin the wrong server.
    #[test]
    fn the_sessions_host_key_does_not_vouch_for_a_different_host() {
        let mut params = handshake("ssh", Some("SHA256:aaa"));
        params
            .extra
            .insert("enable-sftp".to_owned(), "true".to_owned());
        assert!(matches!(
            sftp_host_key_policy(&params, &params.hostname.clone()),
            HostKeyPolicy::Fingerprints(f) if f == vec!["SHA256:aaa".to_owned()]
        ));
        assert!(sftp_host_key_policy(&params, "elsewhere.internal").is_empty());
    }

    fn with_mode(pin: Option<&str>, mode: &str) -> HandshakeParams {
        let mut params = handshake("ssh", pin);
        params
            .extra
            .insert(HOST_KEY_POLICY_PARAM.to_owned(), mode.to_owned());
        params
    }

    #[test]
    fn trust_on_first_use_admits_the_first_key_then_holds_to_the_pin() {
        let first = with_mode(None, "tofu");
        assert!(preflight(Protocol::Ssh, &first).is_ok());
        assert!(matches!(
            session_host_key_policy(&first),
            HostKeyPolicy::AcceptAny
        ));

        let pinned = with_mode(Some("SHA256:aaa"), "tofu");
        assert!(matches!(
            session_host_key_policy(&pinned),
            HostKeyPolicy::Fingerprints(f) if f == vec!["SHA256:aaa".to_owned()]
        ));
    }

    #[test]
    fn unverified_accepts_any_key_even_when_one_is_pinned() {
        let params = with_mode(Some("SHA256:aaa"), "none");
        assert!(preflight(Protocol::Ssh, &params).is_ok());
        assert!(matches!(
            session_host_key_policy(&params),
            HostKeyPolicy::AcceptAny
        ));
    }

    #[test]
    fn an_unknown_mode_fails_closed() {
        for mode in ["", "pinned", "off", "skip"] {
            assert_eq!(
                HostKeyMode::from_param(Some(mode)),
                HostKeyMode::Pinned,
                "{mode:?}"
            );
            assert!(
                preflight(Protocol::Ssh, &with_mode(None, mode)).is_err(),
                "{mode:?}"
            );
        }
        assert_eq!(
            HostKeyMode::from_param(Some(" TOFU ")),
            HostKeyMode::TrustOnFirstUse
        );
    }

    #[test]
    fn same_host_file_transfer_follows_the_session_mode() {
        let mut params = with_mode(None, "tofu");
        params
            .extra
            .insert("enable-sftp".to_owned(), "true".to_owned());
        assert!(preflight(Protocol::Ssh, &params).is_ok());
        assert!(matches!(
            sftp_host_key_policy(&params, &params.hostname.clone()),
            HostKeyPolicy::AcceptAny
        ));
        assert!(sftp_host_key_policy(&params, "elsewhere.internal").is_empty());
    }

    #[test]
    fn legacy_algorithms_are_opt_in() {
        assert_eq!(ssh_algorithms_from(None), Algorithms::Modern);
        assert_eq!(ssh_algorithms_from(Some("false")), Algorithms::Modern);
        assert_eq!(ssh_algorithms_from(Some("true")), Algorithms::Legacy);
    }

    #[test]
    fn an_unticked_feature_box_does_not_force_guacd() {
        for value in ["", "false", "0", "   "] {
            let mut params = handshake("rdp", None);
            params
                .extra
                .insert("enable-sftp".to_owned(), value.to_owned());
            assert!(
                preflight(Protocol::Rdp, &params).is_ok(),
                "{value:?} should not count as enabled"
            );
        }
    }

    #[test]
    fn audio_no_longer_costs_a_connection_the_native_engine() {
        // RDPSND carries playback now. This briefly gated to guacd
        // instead, which meant a connection left at its defaults could
        // not run natively at all.
        for value in [None, Some("false"), Some("true")] {
            let mut params = handshake("rdp", None);
            match value {
                Some(v) => params
                    .extra
                    .insert("disable-audio".to_owned(), v.to_owned()),
                None => params.extra.remove("disable-audio"),
            };
            assert!(
                preflight(Protocol::Rdp, &params).is_ok(),
                "{value:?} should still run natively"
            );
        }
    }

    #[test]
    fn font_smoothing_is_on_unless_an_admin_turns_it_off() {
        // guacd is handed enable-font-smoothing=true when the connection
        // leaves it unset, so the native engine must not read the same
        // silence as "off" and render glyphs differently.
        let params = handshake("rdp", None);
        assert!(flag_or(&params, "enable-font-smoothing", true));
        assert!(!flag(&params, "enable-font-smoothing"));

        let mut off = handshake("rdp", None);
        off.extra
            .insert("enable-font-smoothing".to_owned(), "false".to_owned());
        assert!(!flag_or(&off, "enable-font-smoothing", true));
    }

    /// Agent forwarding is declined rather than routed away: this guacd
    /// does not advertise the parameter either, so rerouting would
    /// decline it just as firmly and lose the native engine as well.
    #[test]
    fn agent_forwarding_is_declined_without_leaving_the_native_engine() {
        let mut params = handshake("ssh", Some("SHA256:aaa"));
        params
            .extra
            .insert("enable-agent".to_owned(), "true".to_owned());
        assert!(preflight(Protocol::Ssh, &params).is_ok());
        assert!(SSH_PARAMS_IGNORED_NATIVELY.contains(&"enable-agent"));
    }

    #[test]
    fn an_ssh_feature_left_off_does_not_force_guacd() {
        for value in ["", "false", "0"] {
            let mut params = handshake("ssh", Some("SHA256:aaa"));
            params
                .extra
                .insert("enable-sftp".to_owned(), value.to_owned());
            assert!(
                preflight(Protocol::Ssh, &params).is_ok(),
                "{value:?} should not count as enabled"
            );
        }
    }

    #[test]
    fn ssh_fidelity_losses_do_not_cost_the_native_engine() {
        // These change how the session looks or what TZ it reports, not
        // whether it works, so they warn rather than reroute.
        for param in SSH_PARAMS_IGNORED_NATIVELY {
            let mut params = handshake("ssh", Some("SHA256:aaa"));
            params.extra.insert((*param).to_owned(), "value".to_owned());
            assert!(
                preflight(Protocol::Ssh, &params).is_ok(),
                "{param} should still run natively"
            );
        }
    }

    /// The actor honours both of these now, so neither may cost a
    /// connection the native engine.
    #[test]
    fn a_recording_the_actor_can_shape_runs_natively() {
        for (option, protocol) in [
            ("recording-exclude-output", Protocol::Rdp),
            ("recording-include-keys", Protocol::Rdp),
            ("recording-include-keys", Protocol::Ssh),
        ] {
            let mut params = handshake("rdp", Some("SHA256:aaa"));
            params.extra.insert(option.to_owned(), "true".to_owned());
            assert!(
                preflight(protocol, &params).is_ok(),
                "{option} should no longer force guacd"
            );
        }
    }

    #[test]
    fn recording_exclusions_the_actor_already_honours_run_natively() {
        // Outbound frames only, so neither is ever recorded anyway.
        let mut params = handshake("rdp", None);
        params
            .extra
            .insert("recording-exclude-mouse".to_owned(), "true".to_owned());
        params
            .extra
            .insert("recording-exclude-touch".to_owned(), "true".to_owned());
        assert!(preflight(Protocol::Rdp, &params).is_ok());
    }

    #[test]
    fn losing_only_fidelity_still_runs_natively() {
        let mut params = handshake("rdp", None);
        params
            .extra
            .insert("timezone".to_owned(), "Europe/London".to_owned());
        params
            .extra
            .insert("enable-touch".to_owned(), "true".to_owned());
        assert!(preflight(Protocol::Rdp, &params).is_ok());
        assert_eq!(
            params_in_use(&params, RDP_PARAMS_IGNORED_NATIVELY),
            vec!["timezone", "enable-touch"]
        );
    }

    #[test]
    fn kerberos_only_rdp_requires_an_explicit_kdc() {
        let mut params = handshake("rdp", None);
        params
            .extra
            .insert(AUTH_PACKAGE_PARAM.to_owned(), "kerberos".to_owned());

        let err = preflight(Protocol::Rdp, &params).unwrap_err();
        assert!(err.contains(KDC_URL_PARAM));
    }

    #[test]
    fn a_bare_kdc_host_is_normalised_to_a_tcp_url() {
        let mut params = handshake("rdp", None);
        params.extra.insert(
            KDC_URL_PARAM.to_owned(),
            "cicsazvm001.capita-ics.co.uk".to_owned(),
        );

        assert_eq!(
            kdc_url(&params).as_deref(),
            Some("tcp://cicsazvm001.capita-ics.co.uk:88")
        );
    }

    #[test]
    fn rdp_desktop_scale_factor_computes_from_dpi() {
        assert_eq!(desktop_scale_factor_from_dpi(96), Some(100));
        assert_eq!(desktop_scale_factor_from_dpi(120), Some(125));
        assert_eq!(desktop_scale_factor_from_dpi(144), Some(150));
        assert_eq!(desktop_scale_factor_from_dpi(192), Some(200));
        assert_eq!(desktop_scale_factor_from_dpi(288), Some(300));
        assert_eq!(desktop_scale_factor_from_dpi(0), None);
        assert_eq!(desktop_scale_factor_from_dpi(50), None);
        assert_eq!(desktop_scale_factor_from_dpi(600), None);
    }
}
