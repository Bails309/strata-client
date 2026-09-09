//! Dual-stack bridge to the native Rust session engine.
//!
//! `guacd` still serves every session by default. When
//! [`strata_session::routing`] says otherwise, [`run_native`] takes the
//! WebSocket instead and drives `crates/strata-session` in-process.
//!
//! The bridge speaks Guacamole Wire Compatibility Mode, so the browser
//! cannot tell which engine it reached — that is the whole point of
//! Phase 2 (ADR-0015). Rollback is `STRATA_SESSION_ENGINE=guacd`.
//!
//! ## Environment
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `STRATA_SESSION_ENGINE` | `guacd` (default), `canary`, or `native` |
//! | `STRATA_SESSION_NATIVE_PERCENT` | canary rollout, 0-100, bucketed per target host |
//! | `STRATA_SESSION_NATIVE_HOSTS` | comma-separated hosts always served natively |
//! | `STRATA_SESSION_NATIVE_PROTOCOLS` | comma-separated protocols eligible for the rollout |

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use secrecy::SecretString;
use strata_session::actor::{
    AuditSink, GuacRecordingSink, NullAuditSink, RecordingPolicy, SessionActor, SessionConfig,
    SessionHandle,
};
use strata_session::engine::keymap::CellSize;
use strata_session::engine::kube::{KubeConfig, KubeEngineFactory};
use strata_session::engine::rdp::layouts::keyboard_layout_id;
use strata_session::engine::rdp::{RdpConfig, RdpEngineFactory, RdpPerformance};
use strata_session::engine::sftp::{SftpConfig, SftpEngine};
use strata_session::engine::ssh::{HostKeyPolicy, SshConfig, SshEngineFactory};
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
use uuid::Uuid;

use crate::error::AppError;
use crate::services::kerberos_realms;
use crate::tunnel::{HandshakeParams, NvrContext};

/// How often the revocation / duration watchdog runs.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);

/// Hard ceiling on a single session, matching the `guacd` path.
const MAX_TUNNEL_DURATION: Duration = Duration::from_secs(8 * 60 * 60);

/// Connection parameter naming the target's accepted host keys.
///
/// SHA-256 fingerprints in OpenSSH's `SHA256:base64` form, comma
/// separated. Without it the native SSH engine has nothing to verify
/// against and the session falls back to `guacd`.
const HOST_KEY_PARAM: &str = "host-key-fingerprint";

/// guacd's own host key parameter, holding a full OpenSSH public key.
///
/// Read as a fallback so a connection configured for guacd verifies the
/// same host when it is routed natively, matching how [`KDC_URL_PARAM`]
/// is shared between the two engines.
pub(crate) const GUACD_HOST_KEY_PARAM: &str = "host-key";

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
    "backspace",
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
const KUBE_PARAMS_IGNORED_NATIVELY: &[&str] = &["font-name", "backspace", "terminal-type"];

/// Parameters that cost only fidelity.
///
/// The session still works, so these are not worth giving up the native
/// engine over — but an administrator who set one should be able to
/// find out why it made no difference.
const RDP_PARAMS_IGNORED_NATIVELY: &[&str] =
    &["color-depth", "force-lossless", "timezone", "enable-touch"];

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
    let mode = std::env::var("STRATA_SESSION_ENGINE")
        .unwrap_or_default()
        .to_ascii_lowercase();

    // Anything unrecognised means guacd. A typo in this variable must
    // not silently enable the new engine.
    let Some(percent) = rollout_percent(&mode) else {
        return RoutingPolicy::disabled();
    };

    let available = RoutingPolicy::compiled_protocols();
    let eligible = eligible_protocols(
        std::env::var("STRATA_SESSION_NATIVE_PROTOCOLS")
            .ok()
            .as_deref(),
        &available,
    );
    let hosts: HashSet<String> = std::env::var("STRATA_SESSION_NATIVE_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
        .collect();

    RoutingPolicy::new(available)
        .with_eligible_protocols(eligible)
        .with_pinned_hosts(hosts)
        .with_rollout_percent(percent)
}

/// Which protocols the rollout may serve natively.
///
/// A blank value counts as unset. Compose passes the variable through as
/// `${STRATA_SESSION_NATIVE_PROTOCOLS:-}`, so commenting the line out in
/// `.env` still delivers an empty string — and reading that literally
/// leaves nothing eligible, which under `native-only` refuses every
/// session rather than serving them all.
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
            // ignoring it would widen the rollout beyond what was asked
            // for, but say so — a typo here silently drops a protocol.
            None => tracing::warn!(
                entry,
                "STRATA_SESSION_NATIVE_PROTOCOLS names an unknown protocol; ignoring it"
            ),
        }
    }
    eligible
}

/// Whether this deployment still has a guacd to fall back to.
///
/// `native-only` is what makes the daemon actually removable: without
/// it a connection the native engine cannot serve is quietly handed to
/// a guacd that is not running, and the operator sees a connection
/// timeout rather than the reason.
pub fn guacd_available() -> bool {
    fallback_available(&std::env::var("STRATA_SESSION_ENGINE").unwrap_or_default())
}

fn fallback_available(mode: &str) -> bool {
    !mode.trim().eq_ignore_ascii_case("native-only")
}

/// Share of sessions this mode sends to the native engine, or `None`
/// when the mode does not enable it at all.
fn rollout_percent(mode: &str) -> Option<u8> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "native" | "native-only" => Some(100),
        "canary" => Some(
            std::env::var("STRATA_SESSION_NATIVE_PERCENT")
                .ok()
                .and_then(|v| v.trim().parse::<u8>().ok())
                .unwrap_or(0),
        ),
        _ => None,
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

/// Decide whether this session should use the native engine.
///
/// Returns `None` to stay on `guacd`. A session that the policy selects
/// but that cannot actually run natively — no host key configured, no
/// font installed — falls back rather than failing: during a canary,
/// breaking a user's session is worse than not moving it.
pub fn select_native(handshake: &HandshakeParams) -> Option<Protocol> {
    let protocol = protocol_from_str(&handshake.protocol)?;
    let decision = policy().decide(protocol, &handshake.hostname);
    if decision.backend != SessionBackend::Native {
        tracing::debug!(
            host = %handshake.hostname,
            protocol = %handshake.protocol,
            reason = decision.reason,
            "routing session to guacd"
        );
        return None;
    }

    if let Err(reason) = preflight(protocol, handshake) {
        tracing::warn!(
            host = %handshake.hostname,
            protocol = %handshake.protocol,
            %reason,
            "session selected for the native engine but cannot run there — \
             falling back to guacd"
        );
        return None;
    }

    tracing::info!(
        host = %handshake.hostname,
        protocol = %handshake.protocol,
        reason = decision.reason,
        "routing session to the native engine"
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
            if host_key_fingerprints(handshake).is_empty() {
                return Err(format!(
                    "connection has no `{HOST_KEY_PARAM}` parameter, and the native SSH \
                     engine will not connect to an unverified host"
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

    // Fall back to the key guacd is already given. An administrator has
    // no way to produce a SHA256 fingerprint from the admin panel, and
    // requiring one would mean every existing SSH connection had to be
    // re-entered before it could run natively.
    //
    // Several keys may be listed: a host usually offers more than one
    // type and which is used comes out of negotiation, so pinning only
    // the first would fail whenever the other was chosen.
    handshake
        .extra
        .get(GUACD_HOST_KEY_PARAM)
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
    ws: WebSocket,
    handshake: HandshakeParams,
    protocol: Protocol,
    nvr: Option<NvrContext>,
    watchdog_token: Option<String>,
    user_id: Uuid,
) -> Result<(), AppError> {
    let engine = connect_engine(protocol, &handshake).await?;
    let audit = open_recording(&handshake).await?;

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
                // Capacity reporting distinguishes the two engines: the
                // native one's footprint is known, guacd's is estimated.
                if let Some(sess) = bandwidth.as_ref() {
                    sess.mark_native();
                }
            }
            None => {
                tracing::error!("Session limit reached — rejecting native tunnel");
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
                send_error(&mut sink, "Session terminated by administrator").await;
                break "terminated by administrator";
            }

            _ = watchdog.tick() => {
                if let Some(reason) = watchdog_verdict(
                    watchdog_token.as_deref(),
                    started_at,
                ) {
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
                    send_error(&mut sink, reason.client).await;
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
                    sess.bytes_from_guacd
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
                            sess.bytes_to_guacd
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
                let mut injected_decoder = GuacDecoder::default();
                injected_decoder.extend(injected.as_bytes());
                if let Err(why) = forward_instructions(&mut injected_decoder, &handle).await {
                    break why;
                }
            }
        }
    };

    tracing::info!(%reason, "native session ending");
    let _ = handle.terminate(reason).await;
    let _ = sink.close().await;

    if let Some(ctx) = nvr.as_ref() {
        finalize_session(ctx, bandwidth.as_ref()).await;
    }
    Ok(())
}

/// Open the `.guac` recording for this session, if recording is on.
async fn open_recording(handshake: &HandshakeParams) -> Result<Box<dyn AuditSink>, AppError> {
    let (Some(dir), Some(name)) = (&handshake.recording_path, &handshake.recording_name) else {
        return Ok(Box::new(NullAuditSink));
    };
    let path = Path::new(dir).join(name);
    let sink = GuacRecordingSink::create(&path)
        .await
        .map_err(|e| AppError::Internal(format!("open recording {}: {e}", path.display())))?;
    tracing::info!(path = %path.display(), "recording native session");
    Ok(Box::new(sink))
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
            client: "Session closed: token revoked",
            audit: "revoked",
        });
    }
    if started_at.elapsed() >= MAX_TUNNEL_DURATION {
        return Some(WatchdogVerdict {
            client: "Session closed: maximum duration reached",
            audit: "max_duration",
        });
    }
    None
}

/// Tell the client why it is being disconnected, best effort.
async fn send_error<S>(sink: &mut S, message: &str)
where
    S: SinkExt<Message> + Unpin,
{
    let instruction = ServerInstruction::Error {
        text: message.to_owned(),
        // 521 = SESSION_CLOSED, matching the guacd path.
        status: 521,
    }
    .to_bytes();
    let Ok(text) = String::from_utf8(instruction.to_vec()) else {
        return;
    };
    let _ = sink.send(Message::Text(text.into())).await;
}

/// Mirror the guacd path's teardown: wake viewers, unregister, clean up
/// shared files, and finalise the recording row.
async fn finalize_session(
    ctx: &NvrContext,
    bandwidth: Option<&Arc<crate::services::session_registry::ActiveSession>>,
) {
    let (bytes_from, bytes_to) = bandwidth.map_or((0i64, 0i64), |sess| {
        (
            sess.bytes_from_guacd.load(Ordering::Relaxed) as i64,
            sess.bytes_to_guacd.load(Ordering::Relaxed) as i64,
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
    match sqlx::query(
        "UPDATE recordings SET duration_secs = $1, bytes_from_guacd = $2, bytes_to_guacd = $3, \
         engine = 'native' WHERE session_id = $4",
    )
    .bind(duration)
    .bind(bytes_from)
    .bind(bytes_to)
    .bind(&ctx.session_id)
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

/// Connect to the target, and attach file transfer if it was asked for.
async fn connect_engine(
    protocol: Protocol,
    handshake: &HandshakeParams,
) -> Result<Box<dyn ProtocolEngine>, AppError> {
    wake_target(handshake).await;

    let spec = TargetSpec {
        protocol,
        hostname: handshake.hostname.clone(),
        port: handshake.port,
        username: handshake.username.clone().unwrap_or_default(),
        secret: SecretString::from(handshake.password.clone().unwrap_or_default()),
        width: handshake.width,
        height: handshake.height,
    };

    let engine = connect_target(protocol, handshake, spec).await?;

    let Some(config) = sftp_config(handshake) else {
        return Ok(engine);
    };
    // A failure here loses file transfer, not the session: the operator
    // is already connected to the target, and dropping them for a
    // secondary channel would be a worse trade than doing without it.
    match SftpEngine::attach(engine, Arc::new(config)).await {
        Ok(engine) => Ok(Box::new(engine)),
        Err(err) => Err(AppError::Internal(format!("native sftp connect: {err}"))),
    }
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
    config.password = get("sftp-password")
        .map(SecretString::from)
        .or_else(|| handshake.password.clone().map(SecretString::from));
    config.private_key = get("sftp-private-key").map(SecretString::from);
    config.passphrase = get("sftp-passphrase").map(SecretString::from);
    config.root = get("sftp-root-directory").unwrap_or_else(|| "/".to_owned());
    config.disable_download = flag(handshake, "sftp-disable-download");
    config.disable_upload = flag(handshake, "sftp-disable-upload");
    config.name = get("sftp-directory").unwrap_or_else(|| "Files".to_owned());
    config.host_keys =
        HostKeyPolicy::Fingerprints(sftp_host_key_fingerprints(handshake, &hostname));
    Some(config)
}

/// Fingerprints the file-transfer host is allowed to present.
///
/// An explicit `sftp-host-key` wins. Otherwise the session's own pinned
/// key is reused, but only when the transfer goes to the same host —
/// trusting it for a different one would pin the wrong server.
fn sftp_host_key_fingerprints(handshake: &HandshakeParams, sftp_host: &str) -> Vec<String> {
    if let Some(raw) = handshake.extra.get("sftp-host-key") {
        let explicit = fingerprints_from(raw);
        if !explicit.is_empty() {
            return explicit;
        }
    }
    if sftp_host == handshake.hostname {
        return host_key_fingerprints(handshake);
    }
    Vec::new()
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
) -> Result<Box<dyn ProtocolEngine>, AppError> {
    match protocol {
        Protocol::Ssh => {
            warn_ignored_params(handshake, SSH_PARAMS_IGNORED_NATIVELY, "ssh");
            let factory = SshEngineFactory::new(
                SshConfig::with_fingerprints(host_key_fingerprints(handshake))
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
                    .with_command(handshake.extra.get("command").cloned()),
            );
            let engine = factory
                .connect(spec)
                .await
                .map_err(|e| AppError::Internal(format!("native ssh connect: {e}")))?;

            let font = TerminalFont::discover(terminal_font_size(handshake))
                .map_err(|e| AppError::Internal(format!("terminal font: {e}")))?;

            let mut rasteriser = RasterisingEngine::with_appearance(
                engine,
                font,
                handshake.width,
                handshake.height,
                &terminal_appearance(handshake),
            );
            if let Some(typescript) = open_typescript(handshake).await? {
                rasteriser = rasteriser.with_typescript(typescript);
            }
            Ok(Box::new(rasteriser))
        }
        Protocol::Rdp => {
            warn_unsupported_rdp_params(handshake);
            let layout = handshake
                .extra
                .get("server-layout")
                .and_then(|name| keyboard_layout_id(name));
            let factory = RdpEngineFactory::new(RdpConfig {
                domain: handshake.domain.clone(),
                kdc_url: kdc_url(handshake),
                keyboard_layout: layout.unwrap_or(RdpConfig::default().keyboard_layout),
                client_name: handshake
                    .extra
                    .get("client-name")
                    .map(|n| n.trim())
                    .filter(|n| !n.is_empty())
                    .map_or_else(|| RdpConfig::default().client_name, str::to_owned),
                read_only: flag(handshake, "read-only"),
                disable_copy: flag(handshake, "disable-copy"),
                disable_paste: flag(handshake, "disable-paste"),
                cert_policy: rdp_cert_policy(handshake).map_err(AppError::Validation)?,
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
            });
            factory
                .connect(spec)
                .await
                .map_err(|e| AppError::Internal(format!("native rdp connect: {e}")))
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
                .map_err(|e| AppError::Internal(format!("native vnc connect: {e}")))
        }
        Protocol::KubeExec => {
            warn_ignored_params(handshake, KUBE_PARAMS_IGNORED_NATIVELY, "kubernetes");
            let factory = KubeEngineFactory::new(KubeConfig {
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
                cell: CellSize::default(),
                read_only: flag(handshake, "read-only"),
                disable_copy: flag(handshake, "disable-copy"),
                disable_paste: flag(handshake, "disable-paste"),
            });
            let engine = factory
                .connect(spec)
                .await
                .map_err(|e| AppError::Internal(format!("native kubernetes connect: {e}")))?;

            let font = TerminalFont::discover(terminal_font_size(handshake))
                .map_err(|e| AppError::Internal(format!("terminal font: {e}")))?;

            let mut rasteriser = RasterisingEngine::with_appearance(
                engine,
                font,
                handshake.width,
                handshake.height,
                &terminal_appearance(handshake),
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn handshake(protocol: &str, fingerprint: Option<&str>) -> HandshakeParams {
        let mut extra = std::collections::HashMap::new();
        if let Some(fp) = fingerprint {
            extra.insert(HOST_KEY_PARAM.to_owned(), fp.to_owned());
        }
        HandshakeParams {
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
            create_recording_path: false,
            width: 1024,
            height: 768,
            dpi: 96,
            extra,
        }
    }

    /// SHA-256 of the empty input: a real digest, so it parses, without
    /// needing a certificate fixture.
    const A_FINGERPRINT: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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

    /// The whole point of the mode: a deployment that removed guacd must
    /// not silently route to it. Every other value keeps the fallback,
    /// including anything unrecognised.
    #[test]
    fn only_native_only_removes_the_fallback() {
        assert!(fallback_available("guacd"));
        assert!(fallback_available("canary"));
        assert!(fallback_available("native"));
        assert!(fallback_available(""));
        assert!(fallback_available("nativeonly"));
        assert!(!fallback_available("native-only"));
        assert!(!fallback_available("  NATIVE-Only "));
    }

    /// `native-only` must still turn the engine on, not just turn the
    /// fallback off.
    #[test]
    fn native_only_is_a_full_rollout() {
        for mode in ["native", "native-only"] {
            assert_eq!(rollout_percent(mode), Some(100), "{mode}");
        }
        assert_eq!(rollout_percent("guacd"), None);
        assert_eq!(rollout_percent("typo"), None);
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
        assert_eq!(
            sftp_host_key_fingerprints(&params, &params.hostname.clone()),
            vec!["SHA256:aaa".to_owned()]
        );
        assert!(sftp_host_key_fingerprints(&params, "elsewhere.internal").is_empty());
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
            .insert("color-depth".to_owned(), "32".to_owned());
        params
            .extra
            .insert("timezone".to_owned(), "Europe/London".to_owned());
        assert!(preflight(Protocol::Rdp, &params).is_ok());
        assert_eq!(
            params_in_use(&params, RDP_PARAMS_IGNORED_NATIVELY),
            vec!["color-depth", "timezone"]
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
}
