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
    AuditSink, GuacRecordingSink, NullAuditSink, SessionActor, SessionConfig, SessionHandle,
};
use strata_session::engine::rdp::layouts::keyboard_layout_id;
use strata_session::engine::rdp::{RdpConfig, RdpEngineFactory, RdpPerformance};
use strata_session::engine::ssh::{SshConfig, SshEngineFactory};
use strata_session::engine::{EngineFactory, Protocol, ProtocolEngine, TargetSpec};
use strata_session::protocol::ServerInstruction;
use strata_session::routing::{RoutingPolicy, SessionBackend};
use strata_session::terminal::{RasterisingEngine, TerminalFont, DEFAULT_FONT_SIZE_PX};
use strata_session::transport::{ClientFrame, GuacDecoder, GuacWireEncoder};
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

/// Connection parameter naming the KDC for Kerberos authentication.
///
/// Shared with the guacd path, whose Kerberos patch reads the same key,
/// so a connection already configured for Kerberos works unchanged when
/// routed to the native engine.
const KDC_URL_PARAM: &str = "kdc-url";
const AUTH_PACKAGE_PARAM: &str = "auth-pkg";

/// Connection parameters naming a feature the native RDP engine does
/// not implement at all.
///
/// guacd does implement these, so a connection asking for one is routed
/// there instead. Running it natively would drop a setting an
/// administrator deliberately chose, and a redirected drive or printer
/// that silently fails to appear is worse than a slower session.
const RDP_FEATURES_REQUIRING_GUACD: &[&str] = &[
    "enable-drive",
    "enable-printing",
    "enable-sftp",
    "enable-audio-input",
    "remote-app",
    "initial-program",
    "console",
    "gateway-hostname",
    "wol-send-packet",
    "load-balance-info",
    "preconnection-id",
    "preconnection-blob",
];

/// Recording options that change what the audit trail must contain.
///
/// The native actor records outbound frames only, so it records neither
/// keystrokes nor mouse movement. `recording-exclude-mouse` and
/// `-exclude-touch` are therefore already satisfied, but these two are
/// not, and both leave the recording differing from what was
/// authorised: one captures screen content that was meant to be
/// excluded, the other omits keystrokes that were meant to be kept.
/// Neither is acceptable to paper over on an access gateway.
const RECORDING_OPTIONS_REQUIRING_GUACD: &[&str] =
    &["recording-exclude-output", "recording-include-keys"];

/// Parameters that cost only fidelity.
///
/// The session still works, so these are not worth giving up the native
/// engine over — but an administrator who set one should be able to
/// find out why it made no difference.
const RDP_PARAMS_IGNORED_NATIVELY: &[&str] = &[
    "color-depth",
    "enable-h264",
    "force-lossless",
    "timezone",
    "enable-touch",
    "resize-method",
];

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
fn warn_unsupported_rdp_params(handshake: &HandshakeParams) {
    let ignored = params_in_use(handshake, RDP_PARAMS_IGNORED_NATIVELY);
    if !ignored.is_empty() {
        tracing::warn!(
            params = ?ignored,
            "native rdp engine ignores these connection parameters; \
             the session works but will not match how it is configured"
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
    let percent = match mode.as_str() {
        "native" => 100,
        "canary" => std::env::var("STRATA_SESSION_NATIVE_PERCENT")
            .ok()
            .and_then(|v| v.trim().parse::<u8>().ok())
            .unwrap_or(0),
        _ => return RoutingPolicy::disabled(),
    };

    let available = RoutingPolicy::compiled_protocols();
    let eligible = match std::env::var("STRATA_SESSION_NATIVE_PROTOCOLS") {
        Ok(list) => list.split(',').filter_map(protocol_from_str).collect(),
        Err(_) => available.clone(),
    };
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
    // Applies to every protocol: the actor, not the engine, decides
    // what reaches the recording.
    let recording = params_in_use(handshake, RECORDING_OPTIONS_REQUIRING_GUACD);
    if !recording.is_empty() {
        return Err(format!(
            "connection sets {}, and the native engine cannot produce that recording",
            recording.join(", ")
        ));
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
            TerminalFont::discover(DEFAULT_FONT_SIZE_PX).map_err(|e| e.to_string())?;
            Ok(())
        }
        Protocol::Rdp => {
            let needs_guacd = params_in_use(handshake, RDP_FEATURES_REQUIRING_GUACD);
            if !needs_guacd.is_empty() {
                return Err(format!(
                    "connection uses {}, which the native RDP engine does not implement",
                    needs_guacd.join(", ")
                ));
            }
            // Audio playback is carried over RDPSND, so a connection that
            // allows it no longer has to leave the native engine.
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
        other => Err(format!("no native engine for {}", other.as_str())),
    }
}

fn host_key_fingerprints(handshake: &HandshakeParams) -> Vec<String> {
    handshake
        .extra
        .get(HOST_KEY_PARAM)
        .map(|raw| {
            raw.split(',')
                .map(|f| f.trim().to_owned())
                .filter(|f| !f.is_empty())
                .collect()
        })
        .unwrap_or_default()
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

async fn connect_engine(
    protocol: Protocol,
    handshake: &HandshakeParams,
) -> Result<Box<dyn ProtocolEngine>, AppError> {
    let spec = TargetSpec {
        protocol,
        hostname: handshake.hostname.clone(),
        port: handshake.port,
        username: handshake.username.clone().unwrap_or_default(),
        secret: SecretString::from(handshake.password.clone().unwrap_or_default()),
        width: handshake.width,
        height: handshake.height,
    };

    match protocol {
        Protocol::Ssh => {
            let factory = SshEngineFactory::new(SshConfig::with_fingerprints(
                host_key_fingerprints(handshake),
            ));
            let engine = factory
                .connect(spec)
                .await
                .map_err(|e| AppError::Internal(format!("native ssh connect: {e}")))?;

            let font = TerminalFont::discover(DEFAULT_FONT_SIZE_PX)
                .map_err(|e| AppError::Internal(format!("terminal font: {e}")))?;

            Ok(Box::new(RasterisingEngine::new(
                engine,
                font,
                handshake.width,
                handshake.height,
            )))
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
                verify_certificate: !handshake.ignore_cert,
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
            });
            factory
                .connect(spec)
                .await
                .map_err(|e| AppError::Internal(format!("native rdp connect: {e}")))
        }
        other => Err(AppError::Internal(format!(
            "no native engine for {}",
            other.as_str()
        ))),
    }
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
    fn protocols_without_an_engine_fail_preflight() {
        let err = preflight(Protocol::Vnc, &handshake("vnc", Some("SHA256:aaa"))).unwrap_err();
        assert!(err.contains("vnc"));
    }

    #[test]
    fn rdp_needs_no_pinned_host_key_or_font() {
        assert!(preflight(Protocol::Rdp, &handshake("rdp", None)).is_ok());
    }

    #[test]
    fn a_connection_needing_device_redirection_is_left_to_guacd() {
        let mut params = handshake("rdp", None);
        params
            .extra
            .insert("enable-drive".to_owned(), "true".to_owned());
        let err = preflight(Protocol::Rdp, &params).unwrap_err();
        assert!(err.contains("enable-drive"), "{err}");
    }

    #[test]
    fn an_unticked_feature_box_does_not_force_guacd() {
        for value in ["", "false", "0", "   "] {
            let mut params = handshake("rdp", None);
            params
                .extra
                .insert("enable-printing".to_owned(), value.to_owned());
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

    #[test]
    fn a_recording_this_engine_cannot_produce_is_left_to_guacd() {
        for (option, protocol) in [
            ("recording-exclude-output", Protocol::Rdp),
            ("recording-include-keys", Protocol::Rdp),
            ("recording-include-keys", Protocol::Ssh),
        ] {
            let mut params = handshake("rdp", Some("SHA256:aaa"));
            params.extra.insert(option.to_owned(), "true".to_owned());
            let err = preflight(protocol, &params).unwrap_err();
            assert!(err.contains(option), "{err}");
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
            .insert("enable-h264".to_owned(), "true".to_owned());
        assert!(preflight(Protocol::Rdp, &params).is_ok());
        assert_eq!(
            params_in_use(&params, RDP_PARAMS_IGNORED_NATIVELY),
            vec!["color-depth", "enable-h264"]
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
